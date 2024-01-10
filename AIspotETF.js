const axios = require('axios');
const OpenAI = require('openai');
const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
require('dotenv').config();
require('events').EventEmitter.defaultMaxListeners = 20;

const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

axios.defaults.httpAgent = httpAgent;
axios.defaults.httpsAgent = httpsAgent;

const openai = new OpenAI();

const apiKey = process.env.BINANCE_API_KEY;
const secretKey = process.env.BINANCE_SECRET_KEY;
const myOpenAIApi = process.env.OPENAI_API_KEY;
const pOUser = process.env.PUSH_USER_ID;
const pOToken = process.env.PUSH_TOKEN;

const symbol = 'BTCUSDT';
const fallbackPrice = 45000;
let size = 1000000;
let myOpenPositions = {};
let priceObj = {};
let infoObj = {};
let orderTriggered = false; 
let sellOrderTriggered = false;
let reconnectionAttempts = 0;
let isConnected = false;
let ws = null;
let socket;



keepBinanceFutAlive();
setPriceObj();
setInfoObj()
setInterval(setInfoObj, 24 * 60 * 60 * 1000);
setInterval(async () => {
  try {
    await getOpenPositions();
  } catch (error) {
    console.error('Error in getMyPosInterval:', error.message);
  }
}, 1000);
reciveNews();




//keep sending ping
function keepBinanceFutAlive() {
  setInterval(() => {
    try {
      axios.get(`https://fapi.binance.com/fapi/v1/ping`);
    } catch (e) {
      console.log('Error sending ping request:', e);
    }
  }, 1000*20);
}


//RECIVE MESSAGE FROM THE SOCKET
async function reciveNews() {
  if (isConnected || ws) {
    console.log("Connection already established or in progress.");
    return;
  }

  console.log('Connecting to WebSocket...');
  isConnected = true;
  ws = new WebSocket('wss://news.treeofalpha.com/ws');

  ws.on('open', () => {
    console.log('Connection with TreeNews opened');
    ws.send('login 842752f3f9b8271110aa50829407762f536b8a34e43661db7f3e3ff4cb8ca772');
    reconnectionAttempts = 0;
  });

  ws.on('message', async (data) => { 
    processMessage(data); 
  });

  ws.on('close', (code) => {
    console.log(`WebSocket connection closed with code ${code}`);
    isConnected = false;
    ws = null;
    attemptReconnect();
  });

  ws.on('error', (e) => {
    console.log('WebSocket connection error: ' + e);
  });
}


function attemptReconnect() {
  if (reconnectionAttempts < 20) {
    setTimeout(() => {
      reciveNews();
      reconnectionAttempts++;
    }, Math.pow(2, reconnectionAttempts) * 1000); 
  } else {
    console.log('Max reconnection attempts reached.');
  }
}


async function processMessage(data) {
  try {
    const message = JSON.parse(data);
    let textToInterpret = "";
    let sender = "";

    if (allowedTitles.includes(message.title)) {
      textToInterpret = message.body;
      sender = message.title; 
    } else if (allowedSources.includes(message.source)) {
      textToInterpret = message.title;
      sender = message.source;  
    } else {
      return; 
    }

    const resp = await getInterpretation(textToInterpret);
    if (resp) {
      const responseObj = JSON.parse(resp);
      if (responseObj.error || responseObj.skipped) {
        console.log(responseObj.reason); 
        return;
      }
      let received = message.time;
      const dateF = responseObj.Timestamp;

      console.log(sender + ': ' + textToInterpret);
      console.log(responseObj);
      console.log(`Time processing: ${(dateF - received) / 1000} seconds`);
      console.log('-------------');
    } else {
      console.error("No response from getInterpretation");
    }
  } catch (error) {
    console.error('Error processing message:', error);
  }
}


/*
const currentTime = Date.now()
const textpro = `{"title":"BTC SPOT ETF HAS BEEN REJECTED","source":"Bloomberg","url":"https://news.treeofalpha.com/?v=551647991204.0009","time":${currentTime},"symbols":[],"en":"DOJ to Announce Binance Settlement in Press Conference Today","_id":"1700581595770DtABSiPCT","suggestions":[{"found":["Binance"],"coin":"BNB","symbols":[{"exchange":"binance-futures","symbol":"BNBUSDT"},{"exchange":"binance","symbol":"BNBUSDT"},{"exchange":"binance","symbol":"BNBBTC"},{"exchange":"binance","symbol":"BNBBUSD"},{"exchange":"binance","symbol":"BNBETH"},{"exchange":"bybit-perps","symbol":"BNBUSDT"}]}],"likes":2,"dislikes":1}`;
setTimeout(() => {
  processMessage(textpro);
}, 15000); 
*/


//GPT INTERPRETATION
async function getInterpretation(text) {
  let latestPrice;
  if (typeof text !== 'string') {
    return JSON.stringify({ error: true, reason: "Input is not a string" });
  }

  conversationHistory.push({ "role": "user", "content": text });

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4", 
      messages: conversationHistory,
    });

    const aiResponse = completion.choices[0].message.content;
    let responseJson = JSON.parse(aiResponse);
      
    conversationHistory.push({ "role": "system", "content": aiResponse });

    if (responseJson.classification === "approval" && responseJson.confidence > 0.85) {
      if (orderTriggered) {
        return JSON.stringify({ skipped: true, reason: "Order already triggered" });
      }
      orderTriggered = true;

      if (priceObj.hasOwnProperty('BTCUSDT') && priceObj['BTCUSDT'].price.length > 5) {
        latestPrice = priceObj['BTCUSDT'].price[0];
        const price5SecAgo = priceObj['BTCUSDT'].price[5]; 
        const priceChangeRatio = Math.abs((latestPrice - price5SecAgo) / price5SecAgo);

        if (priceChangeRatio < 0.02) { 
          size *= 0.6;
        } else if (priceChangeRatio < 0.04) {
          size *= 0.25;
        } else if (priceChangeRatio < 0.1) {
          size *= 0.01;
        }
      } else {
        latestPrice = fallbackPrice;
        size *= 0.4;
      }

      if (myOpenPositions.hasOwnProperty('BTCUSDT') && myOpenPositions['BTCUSDT'].amount > 200000) {
        return JSON.stringify({ skipped: true, reason: "Already have a large position in BTCUSDT, not creating a new order." });
      } else {
        const quantity = size / latestPrice; 
        await createOrder("BUY", symbol, quantity);
        console.log(`Symbol: ${symbol}, Size: ${size}, Quantity: ${quantity}, Latest Price: ${latestPrice}`);
        const message = `BTC SPOT ETF has been approved and an order created for ${quantity} BTC!`;
        sendNotification(pOUser, pOToken, message, 1);
        console.log(message);
      }
    }

    if (responseJson.classification === "rejection" && responseJson.confidence > 0.85) {
      if (sellOrderTriggered) {
        return JSON.stringify({ skipped: true, reason: "Sell order already triggered" });
      }
      sellOrderTriggered = true;

      if (priceObj.hasOwnProperty('BTCUSDT') && priceObj['BTCUSDT'].price.length > 5) {
        latestPrice = priceObj['BTCUSDT'].price[0];
        const price5SecAgo = priceObj['BTCUSDT'].price[5]; 
        const priceChangeRatio = Math.abs((latestPrice - price5SecAgo) / price5SecAgo);

        if (priceChangeRatio < 0.03) { 
          size *= 1.2;
        } else if (priceChangeRatio < 0.065) {
          size *= 0.8;
        } else if (priceChangeRatio < 0.2) {
          size *= 0.01;
        }
      } else {
        latestPrice = fallbackPrice;
        size *= 0.7; 
      }

      if (myOpenPositions.hasOwnProperty('BTCUSDT') && myOpenPositions['BTCUSDT'].amount < (-200000)) {
        return JSON.stringify({ skipped: true, reason: "Already have a large position in BTCUSDT, not creating a new order." });
      } else {
        const quantity = size / latestPrice; 
        await createOrder("SELL", symbol, quantity);
        console.log(`Symbol: ${symbol}, Size: ${size}, Quantity: ${quantity}, Latest Price: ${latestPrice}`);
        const message = `BTC SPOT ETF has been rejected and an order created for ${quantity} BTC!`;
        sendNotification(pOUser, pOToken, message, 1);
        console.log(message);
      }
    }

    responseJson.Timestamp = Date.now(); 
    return JSON.stringify(responseJson);
  } catch (error) {
    console.error('Error in calling OpenAI API:', error);
    return JSON.stringify({ error: true, reason: "OpenAI API call failed" });
  }
}

















//Create a new order
async function createOrder(paramsSide, symbol, quantity) {
  const urlOrder = `https://fapi.binance.com/fapi/v1/order`;
  const timestamp = Date.now();
  const formattedQuantity = formatMarketQuantity(quantity, symbol)
  const orderParams = {
    symbol: symbol,
    type: 'MARKET',
    side: paramsSide,
    quantity: formattedQuantity,
    timestamp: timestamp
  }
  const signature = generateSignature(orderParams);
  const config = {
    headers: { 'X-MBX-APIKEY': apiKey },
    params: { ...orderParams, signature },
  };

  try {
    const response = await axios.post(urlOrder, null, config);
    const order = await queryOrders(response.data.symbol, response.data.orderId);

    const timestampSL = Date.now();
    const formattedStPrice = formatPrice( orderParams.side === 'BUY' ? (parseFloat(order.avgPrice * 0.985)) : (parseFloat(order.avgPrice * 1.015)), orderParams.symbol)
    const stopMarketOrderParams = {
      symbol: orderParams.symbol,
      type: 'STOP_MARKET',
      side: orderParams.side === 'BUY' ? 'SELL' : 'BUY',
      quantity: Number(order.executedQty),
      stopPrice: formattedStPrice,
      timestamp: timestampSL
    };
    const signature = generateSignature(stopMarketOrderParams);
    
    try {
      const config = {
        headers: { 'X-MBX-APIKEY': apiKey },
        params: { ...stopMarketOrderParams, signature },
      };

      const responseSL = await axios.post(urlOrder, null, config);
      return response.data;

    } catch (e) {
      console.log(e.constructor.name, e.message, e.response.data);
      return e.message
    }

  } catch (e) {
    console.log(e.constructor.name, e.message, e.response.data);
    return e.message;
  }
}








//Generate signature when needed
function generateSignature(params) {
  try {
    const queryString = Object.keys(params)
      .map((key) => `${key}=${params[key]}`)
      .join('&');
  
    const signature = crypto.createHmac('sha256', secretKey).update(queryString).digest('hex');
    return signature;
  } catch (e) {
    console.error('Error generating signature:', e);
    return e;
  }
}


// query the status of a specific order
async function queryOrders(symbol, orderId) {
  const timestamp = Date.now();
  const url = `https://fapi.binance.com/fapi/v1/order`;
  const params = { timestamp, symbol, orderId };
  const signature = generateSignature(params);
  const config = {
    headers: { 'X-MBX-APIKEY': apiKey },
    params: { ...params, signature },
  };

  try {
    const response = await axios.get(url, config);
    return response.data;
  } catch (e) {
    console.error(e);
    return e;
  }
}


//Get my open positions
async function getOpenPositions() {
  try {
    const timestamp = Date.now();
    const url = `https://fapi.binance.com/fapi/v2/positionRisk`;
    const params = { timestamp };
    const signature = generateSignature(params);
    const config = {
      headers: { 'X-MBX-APIKEY': apiKey },
      params: { ...params, signature },
    };

    const response = await axios.get(url, config);
    const openPositions = response.data.filter(position => parseFloat(position.notional) !== 0);

    let newOpenPositions = {};

    for (const position of openPositions) {
      const amount = parseFloat(position.markPrice) * parseFloat(position.positionAmt);
      const side = parseFloat(position.positionAmt) > 0 ? 'long' : 'short';
      newOpenPositions[position.symbol] = {
        amount: amount,
        side: side
      };
    }

    myOpenPositions = newOpenPositions;

    return myOpenPositions;
  } catch (e) {
    console.log('Error getting open positions:', e.constructor.name, e.message);
    return e.message; 
  }
}


















// SETTING PARAMETRI E FILTRI


//Keep update real time price of a symbol
function setPriceObj() {
  const streamName = `${symbol.toLowerCase()}@ticker`;

  if (socket) {
    socket.removeAllListeners('message');
    socket.removeAllListeners('close');
    socket.removeAllListeners('error');
    socket.close();  
  }

  socket = new WebSocket(`wss://fstream.binance.com/ws/${streamName}`);

  socket.on('message', (data) => {
    const priceData = JSON.parse(data);
    const price = parseFloat(priceData.c);
    if (!priceObj.hasOwnProperty(symbol)) {
      priceObj[symbol] = { price: [price] }; 
    } else {
      priceObj[symbol].price = priceObj[symbol].price.length < 10 ? [price, ...priceObj[symbol].price] : [price, ...priceObj[symbol].price.slice(0, -1)];
    }
  });

  socket.on('close', (code) => {
    console.log(`WebSocket connection closed with code ${code}`);
    setTimeout(() => setPriceObj(), 1000);
  });

  socket.on('error', (e) => {
    console.log('WebSocket connection error: ' + e);
  });
}



//Create an object with the orders filters
async function setInfoObj() {
    try {
      const response = await axios.get(`https://fapi.binance.com/fapi/v1/exchangeInfo`);
      const tradingSymbols = response.data.symbols.filter((e) => e.status === "TRADING");
      tradingSymbols.forEach((symbol) => { infoObj[symbol.symbol] = symbol.filters });
      return infoObj;
    } catch (e) {
      console.error("Error fetching exchange info:", e);
      return e;
    }
  }
  
  
  // set a price in line with filters
  function formatPrice(price, symbol) {
    const symbolFilters = infoObj[symbol];
    const priceFilter = symbolFilters.find((filter) => filter.filterType === "PRICE_FILTER");
  
    if (!priceFilter) {
      console.error("PRICE_FILTER not found for this symbol.");
      return price;
    }
  
    const { minPrice, maxPrice, tickSize } = priceFilter;
    const priceNumber = parseFloat(price);
    const tickSizeNumber = parseFloat(tickSize);
  
    if (tickSizeNumber === 0) { return price; }
  
    const adjustedPrice = Math.round((priceNumber - parseFloat(minPrice)) / tickSizeNumber) * tickSizeNumber + parseFloat(minPrice);
    const formattedPrice = adjustedPrice.toFixed((tickSize.split('.')[1] || []).length);
  
    return formattedPrice;
  }
  
  
  // set a qty in line with filters with markets orders
  function formatMarketQuantity(quantity, symbol) {
    const symbolFilters = infoObj[symbol];
    const marketLotSizeFilter = symbolFilters.find((filter) => filter.filterType === "MARKET_LOT_SIZE");
  
    if (!marketLotSizeFilter) {
      console.error("MARKET_LOT_SIZE filter not found for this symbol.");
      return { formattedQuantity: quantity, ordersRequired: 1 }; 
    }
  
    const { minQty, maxQty, stepSize } = marketLotSizeFilter;
    const quantityNumber = parseFloat(quantity);
    const stepSizeNumber = parseFloat(stepSize);
    const maxQtyNumber = parseFloat(maxQty);
  
    if (stepSizeNumber === 0) { return { formattedQuantity: quantity, ordersRequired: 1 }; }
  
    let ordersRequired = 1;
    let adjustedQuantity;
  
    if (quantityNumber > maxQtyNumber) {
      ordersRequired = Math.ceil(quantityNumber / maxQtyNumber);
      adjustedQuantity = maxQtyNumber;
    } else {
      adjustedQuantity = Math.round((quantityNumber - parseFloat(minQty)) / stepSizeNumber) * stepSizeNumber + parseFloat(minQty);
    }
    const formattedQuantity = adjustedQuantity.toFixed((stepSize.split('.')[1] || []).length);
  
    return formattedQuantity;
  }

  



  

// SEND NOTIFICATION FOR EVERYTHING HAPPEN
async function sendNotification(user, token, message, priority = 0, title = "(AI) ETF RESPONSE!!") {
    const url = 'https://api.pushover.net/1/messages.json';
  
    const params = {
      token: token,
      user: user,
      message: message,
      title: title,
      priority: priority
    };
  
    try {
      const response = await axios.post(url, params);
      console.log('Notification sent successfully', response.data);
    } catch (error) {
      console.error('Error sending notification', error.data);
    }
  }
  













//RESOURCES

const allowedTitles = [
  "Tree News (@News_Of_Alpha)",
  "DB News (All News)",
  "DB News (Only Urgent)", 
  "db (@tier10k)", 
  "zoomer (@zoomerfied)",
  "Summers (@SummersThings)",
  "Phoenix » PhoenixNews.io (@PhoenixTrades_)",
  "FulcrumNews (@FulcrumNews_)",
];

const allowedSources = [
  "Bloomberg",
];






let conversationHistory = [
  { "role": "system", "content": "I am a language model AI developed by OpenAI. How can I assist you today?" },
  { "role": "user", "content": "i will now start to give you some text and you should interpret it and tell me if the text affirm a BTC SPOT ETF APPROVAL. ready?" },
  { "role": "system", "content": `Yes, I'm ready. Please provide the text, and I'll interpret it for you to determine if it affirms a BTC (Bitcoin) Spot ETF (Exchange-Traded Fund) approval.` },
  { "role": "user", "content": `Whether to Approve or Disapprove a Proposed Rule Change, as Modified by Amendment No. 2,to List and TradeShares of the Wise OriginBitcoin Trustunder BZX Rule 14.11(e)(4), Commodity-Based Trust SharesOn June 30,` },
  { "role": "system", "content": `Based on the text you've provided, it appears to be a statement or a heading related to the decision on whether to approve or disapprove a proposed rule change for listing and trading shares of the Wise Origin Bitcoin Trust under a specific rule (BZX Rule 14.11(e)(4), which pertains to Commodity-Based Trust Shares). However, this text alone does not indicate whether the BTC Spot ETF has been approved or not. It merely states that there is a decision to be made regarding the approval or disapproval of a proposed rule change. For a definitive answer on the approval status, additional information or the conclusion of this statement would be necessary.` },
  { "role": "user", "content": `good. since now the answer need to be a JSON obj, with some classification first (which 4 possibility: text suggest approval, rejection, delayed of the decision or text is not related(approve, reject, delay, other)) and a confidence rate between 0 and 1 that show how confident u are that the text means approval denial, delay or it talk about other stuff.` },
  { "role": "system", "content": `{
    "classification": "delay",
    "confidence": 0.7
  }
  ` },
  { "role": "user", "content": `Possible Bitcoin ETF Delay: ; Notice of Designation of a Longer Period for Commission Action ona Proposed Rule Change to List and Trade Shares of the Hashdex Bitcoin Futures ETFunder NYSE Arca Rule 8.500-E (Trust Units)On September 22, 20
  https://www.sec.gov/files/rules/sro/nysearca/2023/34-98947.pdf` },
  { "role": "system", "content": `{
    "classification": "delay",
    "confidence": 0.85
  }
  ` },
  { "role": "user", "content": `GMT: Introducing the “FSL Legacy Drop”: A Symphony of Fitness, Web3, and Gaming` },
  { "role": "system", "content": `{
    "classification": "other",
    "confidence": 0.9
  }
  ` },
  { "role": "user", "content": `Organizations; Cboe BZX Exchange, Inc.; Notice of Filing of a Proposed Rule Change to List and Trade Shares of the Invesco Galaxy Ethereum ETF under BZX Rule 14.11(e)(4), Commodity-Based Trust Shares Pursuant` },
  { "role": "system", "content": `{
    "classification": "other",
    "confidence": 0.8
  }
  ` },
  { "role": "user", "content": `JUST IN: 🇺🇸SEC Delays Blackrock Spot #Bitcoin ETF Decision -- Again` },
  { "role": "system", "content": `{
    "classification": "delay",
    "confidence": 0.95
  }
  ` },
  { "role": "user", "content": `REPORTS BLACKROCK SPOT ETF IS APPROVED FALSE` },
  { "role": "system", "content": `{
    "classification": "rejection",
    "confidence": 0.95
  }
  ` },
  { "role": "user", "content": `US SECURITIES AND EXCHANGE COMMISSION WILL NOT BE APPEALING COURT DECISION ON GRAYSCALE BITCOIN ETF -SOURCE FAMILIAR - RTRS` },
  { "role": "system", "content": `{
    "classification": "other",
    "confidence": 0.85
  }
  ` },
  { "role": "user", "content": `SEC Reviews Final Decision on Highly Anticipated Bitcoin Spot ETF Amidst Mixed Reactions.` },
  { "role": "system", "content": `{
    "classification": "delay",
    "confidence": 0.75
  }
  ` },
  { "role": "user", "content": `21SHARES & ARK FILED AN UPDATED VERSION OF ITS SPOT BITCOIN ETF S-1 APPLICATION` },
  { "role": "system", "content": `{
    "classification": "delay",
    "confidence": 0.7
  }
  ` },
  { "role": "user", "content": `SEC APPROVES BLACKROCK BTC SPOT ETF` },
  { "role": "system", "content": `{
    "classification": "approval",
    "confidence": 0.95
  }
  ` },
  { "role": "user", "content": `ZIL: How Zilliqa will power the fan loyalty revolution ` },
  { "role": "system", "content": `{
    "classification": "other",
    "confidence": 0.9
  }
  ` },
  { "role": "user", "content": `ARK 21SHARES BITCOIN ETF - SHARES ARE EXPECTED TO BE LISTED FOR TRADING ON CBOE BZX EXCHANGE, INC UNDER THE TICKER SYMBOL ARKB - RTRS` },
  { "role": "system", "content": `{
    "classification": "approval",
    "confidence": 0.9
  }
  ` },
  { "role": "user", "content": `here the etf is not sure, is just an hypotetical situation. i would like u to have lower confidence there` },
  { "role": "system", "content": `{
    "classification": "approval",
    "confidence": 0.6
  }
  ` },
  { "role": "user", "content": ` Update: @ARKInvest just filed another amended prospectus for their spot #bitcoin ETF. Likely means things are likely still moving with SEC conversations. https://t.co/Of2S1pONDc` },
  { "role": "system", "content": `{
    "classification": "delay",
    "confidence": 0.7
  }
  ` },
  { "role": "user", "content": `Breaking News: The U.S. Securities and Exchange Commission (SEC) has granted approval for the first Bitcoin Spot ETF, set to be listed on NASDAQ with immediate effect.` },
  { "role": "system", "content": `{
    "classification": "approval",
    "confidence": 0.95
  }
  ` },
  { "role": "user", "content": `SEC Officially Approves Grayscale's Bitcoin Spot ETF, Allowing Trading to Commence on the New York Stock Exchange Under the Ticker GBTC` },
  { "role": "system", "content": `{
    "classification": "approval",
    "confidence": 0.95
  }
  ` },
  { "role": "user", "content": `ARK 21SHARES BITCOIN ETF - SHARES ARE EXPECTED TO BE LISTED FOR TRADING ON CBOE BZX EXCHANGE, INC UNDER THE TICKER SYMBOL ARKB - RTRS` },
  { "role": "system", "content": `{
    "classification": "other",
    "confidence": 0.6
  }
  ` },
  { "role": "user", "content": `why now other and before it regarded approval?` },
  { "role": "system", "content": `You're right to point out the inconsistency in the classifications. Let me clarify:

  The statement "ARK 21SHARES BITCOIN ETF - SHARES ARE EXPECTED TO BE LISTED FOR TRADING ON CBOE BZX EXCHANGE, INC UNDER THE TICKER SYMBOL ARKB" could suggest a level of progression towards approval, as the expectation of listing on an exchange often follows regulatory approval. However, without explicit confirmation of approval from a regulatory body like the SEC, the classification should indeed be more cautious.
  
  Reflecting on this, a more accurate classification would be:
  
  json
  Copy code
  {
    "classification": "approval",
    "confidence": 0.6
  }
  This classification acknowledges the potential implication of approval while also considering the lack of direct confirmation, resulting in a lower confidence score.` },
  { "role": "user", "content": `great!
  MIDEAST-STOCKS-Major Gulf markets mixed; focus on Fed minutes - RTRS
  ` },
  { "role": "system", "content": `{
    "classification": "other",
    "confidence": 0.95
  }
  ` },
  { "role": "user", "content": "ok. above 0.85 confidence on approval or rejection u should be pretty confident and the text need to be clear about the fact the ETF SPOT BTC has been approved or rejected. no doubt on it from the text" },
  { "role": "system", "content": `Understood. For a confidence level above 0.85 in classifying a text as either approval or rejection of a BTC Spot ETF, the text must provide clear and unequivocal evidence of such a decision, without any ambiguity. I will apply this criterion in future assessments. Thank you for the clarification!` },
];