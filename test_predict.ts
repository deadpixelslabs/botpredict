import axios from 'axios';
async function test() {
  const now = Math.floor(Date.now() / 1000);
  const currentInterval = Math.floor(now / 300) * 300;
  console.log("Current lock interval:", currentInterval);
  try {
    const slug = `btc-updown-5m-${currentInterval}`;
    const res = await axios.get(`https://api.predict.fun/v1/categories/${slug}`, { headers: { "x-api-key": "" }});
    console.log(JSON.stringify(res.data.data.markets[0], null, 2));
    
    // Also try previous interval to see what happened to price to beat
    const slug2 = `btc-updown-5m-${currentInterval - 300}`;
    const res2 = await axios.get(`https://api.predict.fun/v1/categories/${slug2}`, { headers: { "x-api-key": "" }});
    console.log(JSON.stringify(res2.data.data.markets[0], null, 2));
  } catch(e: any) {
    console.error(e.response ? e.response.data : e.message);
  }
}
test();
