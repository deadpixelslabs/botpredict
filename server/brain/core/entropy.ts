export function shannonEntropy(prices: number[]): number {
  if (prices.length < 2) return 1.0;

  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    returns.push(prices[i] > prices[i - 1] ? 1 : 0);
  }

  const p1 = returns.filter(r => r === 1).length / returns.length;
  const p0 = 1 - p1;

  if (p1 === 0 || p0 === 0) return 0.0; // Perfectly directional
  return -(p1 * Math.log2(p1) + p0 * Math.log2(p0));
}

export function permutationEntropy(prices: number[], order = 3): number {
  if (prices.length < order + 1) return 1.0;

  const patterns: Record<string, number> = {};
  const total = prices.length - order + 1;

  for (let i = 0; i <= prices.length - order; i++) {
    const slice = prices.slice(i, i + order);
    // Get rank permutation pattern
    const ranked = slice
      .map((v, idx) => ({ v, idx }))
      .sort((a, b) => a.v - b.v)
      .map(x => x.idx);
    const key = ranked.join(',');
    patterns[key] = (patterns[key] || 0) + 1;
  }

  const maxEntropy = Math.log2(factorial(order));
  let entropy = 0;

  for (const count of Object.values(patterns)) {
    const p = count / total;
    entropy -= p * Math.log2(p);
  }

  // Normalize to 0–1
  return maxEntropy > 0 ? entropy / maxEntropy : 0;
}

function factorial(n: number): number {
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

export interface EntropyScoreResult {
  shannon: number;
  permutation: number;
  combined: number;
  isPredictable: boolean;
}

export function entropyScore(prices: number[]): EntropyScoreResult {
  const s = shannonEntropy(prices);
  const p = permutationEntropy(prices, 3);
  return {
    shannon: s,
    permutation: p,
    combined: (s + p) / 2,
    isPredictable: (s + p) / 2 < 0.75,
  };
}
