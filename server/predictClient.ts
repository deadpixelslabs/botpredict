import { Wallet, formatUnits } from "ethers";
import { OrderBuilder, ChainId, Side } from "@predictdotfun/sdk";
import BigNumber from "bignumber.js";
import { createHash, randomBytes } from "node:crypto";
import axios from "axios";
import http from "node:http";
import https from "node:https";

// Reuse TLS connections. Every request has a deadline; writes are never retried
// after an ambiguous network failure (a timeout is not proof of rejection).
const api = axios.create({
    baseURL: "https://api.predict.fun/v1",
    timeout: 4000,
    httpAgent: new http.Agent({ keepAlive: true, maxSockets: 8 }),
    httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 8 })
});
const builders = new Map<string, Promise<any>>();
const tokens = new Map<string, { token?: string; pending?: Promise<string> }>();
const SCALE = 10n ** 18n;
const TERMINAL_CANCEL = new Set(["CANCELLED", "CANCELED", "INVALIDATED", "EXPIRED", "REJECTED"]);

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function headers(apiKey: string, jwt?: string) {
    return { "x-api-key": apiKey, ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}) };
}
function authKey(pb: any, account: string, apiKey: string): string {
    return `${(account || pb.signer.address).toLowerCase()}:${digest(apiKey)}`;
}

/** Require a fresh signed challenge for an operator-requested readiness check. */
export function invalidatePredictAuth(pb: any, predictAccount: string, apiKey: string): void {
    tokens.delete(authKey(pb, predictAccount, apiKey));
}
function errorMessage(e: any): string {
    // Do not stringify Axios errors: their request configuration contains secrets.
    return String(e?.response?.data?.message || e?.message || "Predict API request failed").slice(0, 300);
}
function isJwtExpired(token: string): boolean {
    try {
        const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
        return !Number.isFinite(payload.exp) || payload.exp * 1000 <= Date.now() + 60000;
    } catch { return true; }
}

export async function getOrderBuilder(privateKey: string, predictAccount: string): Promise<any> {
    const key = digest(`${privateKey}:${predictAccount.toLowerCase()}`);
    const existing = builders.get(key);
    if (existing) return existing;
    const pending = Promise.resolve(OrderBuilder.make(ChainId.BnbMainnet, new Wallet(privateKey), {
        ...(predictAccount ? { predictAccount } : {}),
        generateSalt: () => BigInt(`0x${randomBytes(32).toString("hex")}`).toString()
    }));
    builders.set(key, pending);
    // Bound retained signer material when credentials change repeatedly.
    if (builders.size > 8) builders.delete(builders.keys().next().value!);
    try { return await pending; }
    catch (e) { builders.delete(key); throw e; }
}

export async function getJwtToken(pb: any, predictAccount: string, apiKey: string): Promise<string> {
    const key = authKey(pb, predictAccount, apiKey);
    const state = tokens.get(key) || {};
    if (state.token && !isJwtExpired(state.token)) return state.token;
    if (state.pending) return state.pending;
    tokens.set(key, state);
    state.pending = (async () => {
        const msgRes = await api.get("/auth/message", { headers: headers(apiKey) });
        const message = msgRes.data?.data?.message;
        if (typeof message !== "string" || !message) throw new Error("Auth challenge missing");
        const signature = predictAccount
            ? await pb.signPredictAccountMessage(message)
            : await pb.signer.signMessage(message);
        const authRes = await api.post("/auth", {
            signer: predictAccount || pb.signer.address, signature, message
        }, { headers: headers(apiKey) });
        const token = authRes.data?.data?.token;
        if (typeof token !== "string" || !token || isJwtExpired(token)) throw new Error("Invalid auth token");
        state.token = token;
        return token;
    })();
    try { return await state.pending; }
    catch (e) { state.token = undefined; throw new Error(`Auth failed: ${errorMessage(e)}`); }
    finally { state.pending = undefined; }
}

export async function preWarmPredictClient(privateKey: string, predictAccount: string, apiKey: string): Promise<void> {
    if (!privateKey || !apiKey) return;
    try { await getJwtToken(await getOrderBuilder(privateKey, predictAccount), predictAccount, apiKey); }
    catch (e) { console.warn(`[Predict Client] Prewarm failed: ${errorMessage(e)}`); }
}

async function authenticated<T>(pb: any, account: string, apiKey: string, request: (jwt: string) => Promise<T>): Promise<T> {
    const jwt = await getJwtToken(pb, account, apiKey);
    try { return await request(jwt); }
    catch (e: any) {
        // A 401 is an explicit rejection, so repeating the exact signed payload is safe.
        if (e?.response?.status !== 401) throw e;
        tokens.delete(authKey(pb, account, apiKey));
        return request(await getJwtToken(pb, account, apiKey));
    }
}

export async function getPredictMarket(intervalStartTs: number, apiKey: string): Promise<any> {
    if (!Number.isSafeInteger(intervalStartTs) || intervalStartTs <= 0) throw new Error("Invalid market interval");
    try {
        const slug = `btc-updown-5m-${intervalStartTs}`;
        const res = await api.get(`/categories/${slug}`, { headers: headers(apiKey) });
        const markets = res.data?.data?.markets;
        if (!Array.isArray(markets)) throw new Error("Malformed market response");
        return markets.find((m: any) => m.tradingStatus === "OPEN") || markets[0] || null;
    } catch (e: any) {
        if (e?.response?.status === 404) return null;
        throw new Error(`Market lookup failed: ${errorMessage(e)}`);
    }
}

function toWei(value: number): bigint {
    if (!Number.isFinite(value) || value <= 0) throw new Error("Amount must be finite and positive");
    return BigInt(new BigNumber(value.toString()).times("1e18").integerValue(BigNumber.ROUND_DOWN).toFixed(0));
}

/** Exact budget math; BUY amount is total collateral budget, SELL amount is shares. */
export function calculateLimitOrderInput(amount: number, price: number, action: "BUY" | "SELL", decimalPrecision: number, feeRateBps: number) {
    if (!Number.isFinite(price) || price <= 0 || price >= 1) throw new Error("Price must be strictly between 0 and 1");
    if (!Number.isInteger(decimalPrecision) || decimalPrecision < 1 || decimalPrecision > 6) throw new Error("Unsupported market price precision");
    if (!Number.isInteger(feeRateBps) || feeRateBps < 0 || feeRateBps > 10000) throw new Error("Invalid market fee rate");
    const tick = 10n ** BigInt(18 - decimalPrecision);
    const rawPrice = toWei(price);
    const pricePerShareWei = action === "BUY" ? rawPrice / tick * tick : (rawPrice + tick - 1n) / tick * tick;
    if (pricePerShareWei <= 0n || pricePerShareWei >= SCALE) throw new Error("Price outside the market tick range");
    const amountWei = toWei(amount);
    // Reserve the full fee rate as a conservative upper bound, regardless of
    // whether this market charges taker fees in collateral or received shares.
    const budgetWei = action === "BUY" ? amountWei * 10000n / (10000n + BigInt(feeRateBps)) : amountWei;
    const quantityWei = action === "BUY" ? budgetWei * SCALE / pricePerShareWei : amountWei;
    if (quantityWei < 10n ** 16n) throw new Error("Order is below 0.01 shares; quantity will not be increased automatically");
    return { pricePerShareWei, quantityWei, amountWei };
}

export interface PredictOrderPlacement {
    orderId: string;
    hash: string;
    placedAt: number;
    lockTime: number;
    epochIndex: number;
    limitPrice: number;
    sharesQuantity: number;
    principalUsdt: number;
    feeRateBps: number;
    expiration: number;
}

export class PredictOrderSubmissionError extends Error {
    readonly uncertain = true;
    constructor(message: string, public readonly orderHash: string, public readonly placement: Omit<PredictOrderPlacement, "orderId">) {
        super(message);
        this.name = "PredictOrderSubmissionError";
        Object.assign(this, placement);
    }
}

export async function placePredictOrder(
    position: "BULL" | "BEAR", amountUsdt: number, privateKey: string, predictAccount: string,
    apiKey: string, customPricePerShare = 0.5, targetLockTime = Math.floor(Date.now() / 1000),
    action: "BUY" | "SELL" = "BUY", prefetchedMarket?: any, prefetchedOutcome?: any, beforeSubmit?: () => Promise<void>
): Promise<PredictOrderPlacement> {
    const catSlug = `btc-updown-5m-${targetLockTime}`;
    const targetMarket = prefetchedMarket || await getPredictMarket(targetLockTime, apiKey);
    if (!targetMarket || targetMarket.tradingStatus !== "OPEN") throw new Error("Target market is not OPEN");
    if (targetMarket.categorySlug && targetMarket.categorySlug !== catSlug) throw new Error("Prefetched market belongs to another interval");
    const name = position === "BULL" ? "up" : "down";
    const outcome = prefetchedOutcome || targetMarket.outcomes?.find((o: any) => String(o.name).toLowerCase() === name);
    if (!outcome?.onChainId || String(outcome.name).toLowerCase() !== name || !targetMarket.outcomes?.some((o: any) => String(o.onChainId) === String(outcome.onChainId))) {
        throw new Error("Outcome does not belong to the target market");
    }
    if (typeof targetMarket.isNegRisk !== "boolean" || typeof targetMarket.isYieldBearing !== "boolean") throw new Error("Market exchange flags missing");
    const feeRateBps = targetMarket.feeRateBps;
    const input = calculateLimitOrderInput(amountUsdt, customPricePerShare, action, targetMarket.decimalPrecision, feeRateBps);
    const pb = await getOrderBuilder(privateKey, predictAccount);
    await getJwtToken(pb, predictAccount, apiKey); // Authenticate before the short order-validity window starts.
    const side = action === "BUY" ? Side.BUY : Side.SELL;
    const amounts = pb.getLimitOrderAmounts({ side, pricePerShareWei: input.pricePerShareWei, quantityWei: input.quantityWei });
    if (action === "SELL" && amounts.pricePerShare < input.pricePerShareWei) throw new Error("SDK precision would violate the minimum sell price");
    const principalWei = action === "BUY" ? amounts.makerAmount : amounts.takerAmount;
    if (action === "BUY" && principalWei + (principalWei * BigInt(feeRateBps) + 9999n) / 10000n > input.amountWei) throw new Error("Order exceeds total collateral budget");
    if (action === "SELL" && amounts.makerAmount > input.amountWei) throw new Error("Order exceeds requested share quantity");
    const now = Math.floor(Date.now() / 1000);
    // /orders/remove is only off-chain removal. Limit stale signatures to 15s.
    const expiration = Math.min(now + 15, targetLockTime + 300 - 1);
    if (expiration <= now + 1) throw new Error("Market interval has ended or is about to end");
    const account = predictAccount || pb.signer.address;
    const order = pb.buildOrder("LIMIT", {
        maker: account, signer: account, side, tokenId: outcome.onChainId,
        makerAmount: amounts.makerAmount, takerAmount: amounts.takerAmount,
        nonce: 0n, feeRateBps, expiresAt: new Date(expiration * 1000)
    });
    const typedData = pb.buildTypedData(order, { isNegRisk: targetMarket.isNegRisk, isYieldBearing: targetMarket.isYieldBearing });
    const signedOrder = await pb.signTypedDataOrder(typedData);
    const hash = pb.buildTypedDataHash(typedData);
    const placement = {
        hash, placedAt: Date.now(), lockTime: targetLockTime, epochIndex: Math.floor(targetLockTime / 300),
        limitPrice: Number(formatUnits(amounts.pricePerShare, 18)),
        sharesQuantity: Number(formatUnits(amounts.amount, 18)),
        principalUsdt: Number(formatUnits(principalWei, 18)), feeRateBps, expiration
    };
    const payload = { data: {
        // SDK and REST API use 18-decimal integer strings, never floating-point wei.
        pricePerShare: amounts.pricePerShare.toString(), strategy: "LIMIT",
        order: Object.fromEntries(Object.entries({ ...signedOrder, hash }).map(([key, value]) => [key, typeof value === "bigint" ? value.toString() : value]))
    } };
    let attemptedSubmission = false;
    try {
        const res = await authenticated(pb, predictAccount, apiKey, async jwt => {
            // Revalidate ownership after signing/auth and before every network write, including a 401 retry.
            await beforeSubmit?.();
            if (Math.floor(Date.now() / 1000) >= expiration - 1) throw new Error("Signed order expired before submission");
            attemptedSubmission = true;
            return api.post("/orders", payload, { headers: headers(apiKey, jwt) });
        });
        if (res.data?.success !== true || !res.data?.data?.orderId) {
            // A malformed success response may still correspond to an accepted order.
            throw new PredictOrderSubmissionError("Order response is inconclusive; reconcile by hash", hash, placement);
        }
        return { ...placement, orderId: String(res.data.data.orderId), hash: res.data.data.orderHash || hash };
    } catch (e: any) {
        if (e instanceof PredictOrderSubmissionError) throw e;
        if (attemptedSubmission && (!e?.response || e.response.status >= 500)) {
            throw new PredictOrderSubmissionError(`Submission outcome unknown: ${errorMessage(e)}`, hash, placement);
        }
        throw new Error(`Order rejected${e?.response ? ` (${e.response.status})` : ""}: ${errorMessage(e)}`);
    }
}

function decimal(value: unknown): BigNumber | undefined {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") return undefined;
    const n = new BigNumber(String(value));
    return n.isFinite() && n.gte(0) ? n : undefined;
}
function shares(value: unknown): number | undefined {
    const n = decimal(value);
    if (!n) return undefined;
    // REST order quantities are integer wei; tolerate explicit human decimals.
    return (String(value).includes(".") ? n : n.div("1e18")).toNumber();
}
function price(value: unknown): number | undefined {
    const n = decimal(value);
    if (!n) return undefined;
    const p = n.gt(1) ? n.div("1e18").toNumber() : n.toNumber();
    return p > 0 && p < 1 ? p : undefined;
}

export interface PredictOrderStatus {
    status: string;
    filled: boolean;
    filledRatio: number;
    cancelConfirmed: boolean;
    uncertain: boolean;
    filledQuantity?: number;
    spentUsdt?: number;
    averageFillPrice?: number;
    limitPrice?: number;
    bookRemovalConfirmed?: boolean;
    onchainCancelled?: boolean;
}

/** Interpret only observed amounts; a partial status alone is not a 50% fill. */
export function summarizePredictOrder(orderData: any): PredictOrderStatus {
    if (!orderData || typeof orderData !== "object") return { status: "UNKNOWN", filled: false, filledRatio: 0, cancelConfirmed: false, uncertain: true };
    const status = String(orderData.status || "UNKNOWN").toUpperCase();
    const amount = decimal(orderData.amount);
    const amountFilled = decimal(orderData.amountFilled);
    let ratio: number | undefined;
    let exactFull = false;
    if (amount?.gt(0) && amountFilled) {
        exactFull = amountFilled.gte(amount);
        ratio = BigNumber.minimum(1, amountFilled.div(amount)).toNumber();
    }
    // remainingTakerAmount only applies when it is actually present, never assume zero.
    if (ratio === undefined) {
        const original = decimal(orderData.order?.takerAmount ?? orderData.takerAmount);
        const remaining = decimal(orderData.remainingTakerAmount);
        if (original?.gt(0) && remaining && remaining.lte(original)) {
            exactFull = remaining.isZero();
            ratio = original.minus(remaining).div(original).toNumber();
        }
    }
    const filled = status === "FILLED" || exactFull;
    const cancelConfirmed = TERMINAL_CANCEL.has(status);
    const filledRatio = filled ? 1 : Math.min(1 - Number.EPSILON, ratio ?? 0);
    const explicitAverage = price(orderData.averageFillPrice ?? orderData.avgFillPrice);
    let limitPrice = price(orderData.pricePerShare);
    const maker = decimal(orderData.order?.makerAmount);
    const taker = decimal(orderData.order?.takerAmount);
    if (!limitPrice && maker?.gt(0) && taker?.gt(0)) {
        limitPrice = Number(orderData.order?.side) === Side.SELL ? taker.div(maker).toNumber() : maker.div(taker).toNumber();
    }
    return {
        status: filled ? "FILLED" : status, filled, filledRatio, cancelConfirmed,
        uncertain: status === "UNKNOWN" || (!filled && ratio === undefined),
        filledQuantity: amountFilled ? shares(orderData.amountFilled) : undefined,
        // Limit order price is not an actual volume-weighted fill price.
        averageFillPrice: explicitAverage,
        limitPrice: limitPrice && limitPrice > 0 && limitPrice < 1 ? limitPrice : undefined,
        spentUsdt: orderData.valueFilled !== undefined ? shares(orderData.valueFilled) : undefined,
        onchainCancelled: status === "INVALIDATED"
    };
}

async function fetchOrder(pb: any, predictAccount: string, apiKey: string, orderHash: string): Promise<any> {
    const res = await authenticated(pb, predictAccount, apiKey, jwt => api.get(`/orders/${encodeURIComponent(orderHash)}`, { headers: headers(apiKey, jwt), timeout: 3000 }));
    if (res.data?.success !== true || !res.data?.data) throw new Error("Malformed order status response");
    return res.data.data;
}

export async function checkPredictOrderStatus(
    orderHash: string, privateKey: string, predictAccount: string, apiKey: string, _orderId: string
): Promise<PredictOrderStatus> {
    try {
        const pb = await getOrderBuilder(privateKey, predictAccount);
        return summarizePredictOrder(await fetchOrder(pb, predictAccount, apiKey, orderHash));
    } catch {
        // /orders/{hash} accepts a hash, not an ID. An outage/404 is not zero fill.
        return summarizePredictOrder(null);
    }
}

export async function checkAndCancelPredictOrder(
    orderHash: string, privateKey: string, predictAccount: string, apiKey: string, orderId: string, delayMs = 250
): Promise<PredictOrderStatus> {
    const pb = await getOrderBuilder(privateKey, predictAccount);
    let before: PredictOrderStatus;
    try { before = summarizePredictOrder(await fetchOrder(pb, predictAccount, apiKey, orderHash)); }
    catch { before = summarizePredictOrder(null); }
    if (before.filled || before.cancelConfirmed) return before;
    let bookRemovalConfirmed = false;
    if (orderId) {
        try {
            const res = await authenticated(pb, predictAccount, apiKey, jwt => api.post("/orders/remove", { data: { ids: [orderId] } }, { headers: headers(apiKey, jwt) }));
            bookRemovalConfirmed = res.data?.success === true && Array.isArray(res.data.removed) && res.data.removed.map(String).includes(String(orderId));
        } catch { /* Inconclusive removal must leave the position reserved. */ }
    }
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, Math.min(1500, delayMs)));
    try {
        const after = summarizePredictOrder(await fetchOrder(pb, predictAccount, apiKey, orderHash));
        // Trust final observed status, not the remove request succeeding or a noop.
        return { ...after, bookRemovalConfirmed };
    } catch {
        return { ...before, status: "UNKNOWN", cancelConfirmed: false, uncertain: true, bookRemovalConfirmed };
    }
}

export async function getUserPositions(privateKey: string, predictAccount: string, apiKey: string): Promise<any[]> {
    const pb = await getOrderBuilder(privateKey, predictAccount);
    const account = predictAccount || pb.signer.address;
    try {
        const res = await authenticated(pb, predictAccount, apiKey, jwt => api.get(`/positions/${account}`, { headers: headers(apiKey, jwt) }));
        const data = res.data?.data;
        if (res.data?.success === false) throw new Error("Positions request rejected");
        if (Array.isArray(data)) return data;
        if (Array.isArray(data?.positions)) return data.positions;
        throw new Error("Malformed positions response");
    } catch (e) { throw new Error(`Positions unavailable: ${errorMessage(e)}`); }
}
