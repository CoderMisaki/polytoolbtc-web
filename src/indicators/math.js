function calcSMA(data, period, key) { 
    let res = [];
    let sum = 0; 
    for (let i = 0; i < data.length; i++) { 
        sum += key ? data[i][key] : data[i]; 
        if (i >= period) {
            sum -= key ? data[i-period][key] : data[i-period]; 
        }
        res.push(i >= period - 1 ? sum / period : sum / (i + 1)); 
    } 
    return res; 
}

function calcEMA(data, period, key = 'close') { 
    if (!data || data.length === 0) return []; 
    let res = [];
    let k = 2 / (period + 1);
    let ema = data[0][key]; 
    for (let i = 0; i < data.length; i++) { 
        ema = (data[i][key] - ema) * k + ema; 
        res.push({ time: data[i].time, value: ema }); 
    } 
    return res; 
}

function calcMACD(data, fast=12, slow=26, sig=9) { 
    if (!data || data.length < slow) return []; 
    let emaF = calcEMA(data, fast, 'close');
    let emaS = calcEMA(data, slow, 'close');
    let macdLine = []; 
    for (let i = 0; i < data.length; i++) {
        macdLine.push({ time: data[i].time, value: i < slow - 1 ? 0 : emaF[i].value - emaS[i].value }); 
    }
    let sigLine = calcEMA(macdLine, sig, 'value');
    let hist = []; 
    for (let i = 0; i < data.length; i++) {
        hist.push({ time: data[i].time, value: macdLine[i].value - sigLine[i].value, macd: macdLine[i].value, signal: sigLine[i].value }); 
    }
    return hist; 
}


const INDICATOR_INCREMENTAL_STATE_VERSION = 1;
const EXPLICIT_EMA_PERIODS = [21, 55, 200];
const EXPLICIT_RSI_PERIODS = [14, 21];
const EXPLICIT_MACD_CONFIG = { fast: 12, slow: 26, signal: 9 };

// Only the snapshot of the previous candle is ever read back (to recompute a
// live last-candle replacement), so the store is a small rolling map instead
// of one deep clone per candle. Snapshotting every candle made indicator
// memory grow O(n^2): at 12k candles it held ~900 MB on the heap.
const SNAPSHOT_KEEP = 4;

function createEmptyIncrementalState() {
    return {
        version: INDICATOR_INCREMENTAL_STATE_VERSION,
        lastTime: null,
        length: 0,
        ema: {},
        rsi: {},
        macd: {
            fastPeriod: EXPLICIT_MACD_CONFIG.fast,
            slowPeriod: EXPLICIT_MACD_CONFIG.slow,
            signalPeriod: EXPLICIT_MACD_CONFIG.signal,
            fast: null,
            slow: null,
            signal: null
        },
        snapshots: new Map()
    };
}

function setSnapshot(state, index, snapshot) {
    state.snapshots.set(index, snapshot);
    if (state.snapshots.size > SNAPSHOT_KEEP) {
        // Map iterates in insertion order: drop the oldest entries.
        for (const key of state.snapshots.keys()) {
            if (state.snapshots.size <= SNAPSHOT_KEEP) break;
            state.snapshots.delete(key);
        }
    }
}

function getSnapshot(state, index) {
    const snap = state.snapshots.get(index);
    return snap === undefined ? null : snap;
}

function dropSnapshotsFrom(state, index) {
    for (const key of Array.from(state.snapshots.keys())) {
        if (key >= index) state.snapshots.delete(key);
    }
}

function ensureIncrementalState() {
    if (!AppState.indicatorState || AppState.indicatorState.version !== INDICATOR_INCREMENTAL_STATE_VERSION) {
        AppState.indicatorState = createEmptyIncrementalState();
    }
    return AppState.indicatorState;
}

function resetIncrementalIndicatorState() {
    AppState.indicatorState = createEmptyIncrementalState();
    return AppState.indicatorState;
}

function syncRsiLookup() {
    rsiLookupByTime.clear();
    for (let i = 0; i < AppState.indicators.rsi.length; i++) {
        rsiLookupByTime.set(AppState.indicators.rsi[i].time, AppState.indicators.rsi[i].value);
    }
}

function updateExplicitEmaState(candle, state, period, outputKey) {
    const emaKey = String(period);
    const previous = state.ema[emaKey];
    const k = 2 / (period + 1);
    const value = previous && Number.isFinite(previous.value)
        ? (candle.close - previous.value) * k + previous.value
        : candle.close;

    state.ema[emaKey] = { period, value, lastTime: candle.time };
    AppState.indicators[outputKey].push({ time: candle.time, value });
    return value;
}

function updateExplicitRsiState(data, index, state, period, outputKey) {
    const rsiKey = String(period);
    const previous = state.rsi[rsiKey] || {
        period,
        seedGain: 0,
        seedLoss: 0,
        avgGain: null,
        avgLoss: null,
        lastClose: null,
        samples: 0,
        ready: false
    };

    const close = data[index].close;
    const priorClose = index > 0 ? data[index - 1].close : previous.lastClose;
    let value = 50;

    if (index === 0 || !Number.isFinite(priorClose)) {
        previous.lastClose = close;
        previous.samples = 0;
        state.rsi[rsiKey] = previous;
        AppState.indicators[outputKey].push({ time: data[index].time, value });
        return value;
    }

    const change = close - priorClose;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;

    if (!previous.ready) {
        previous.seedGain += gain;
        previous.seedLoss += loss;
        previous.samples += 1;

        if (previous.samples >= period) {
            previous.avgGain = safeDiv(previous.seedGain, period);
            previous.avgLoss = safeDiv(previous.seedLoss, period);
            previous.ready = true;
            const rs = previous.avgLoss === 0 ? 100 : safeDiv(previous.avgGain, previous.avgLoss);
            value = previous.avgLoss === 0 ? 100 : 100 - (100 / (1 + rs));
        }
    } else {
        previous.avgGain = (previous.avgGain * (period - 1) + gain) / period;
        previous.avgLoss = (previous.avgLoss * (period - 1) + loss) / period;
        const rs = previous.avgLoss === 0 ? 100 : safeDiv(previous.avgGain, previous.avgLoss);
        value = previous.avgLoss === 0 ? 100 : 100 - (100 / (1 + rs));
    }

    previous.lastClose = close;
    state.rsi[rsiKey] = previous;
    AppState.indicators[outputKey].push({ time: data[index].time, value });
    return value;
}

function snapshotExplicitState(state) {
    const ema = {};
    Object.keys(state.ema).forEach((key) => {
        const e = state.ema[key];
        ema[key] = { period: e.period, value: e.value, lastTime: e.lastTime };
    });
    const rsi = {};
    Object.keys(state.rsi).forEach((key) => {
        rsi[key] = Object.assign({}, state.rsi[key]);
    });
    return {
        lastTime: state.lastTime,
        length: state.length,
        ema: ema,
        rsi: rsi,
        macd: {
            fastPeriod: state.macd.fastPeriod,
            slowPeriod: state.macd.slowPeriod,
            signalPeriod: state.macd.signalPeriod,
            fast: state.macd.fast,
            slow: state.macd.slow,
            signal: state.macd.signal
        }
    };
}

function restoreExplicitStateSnapshot(state, snapshot) {
    if (!snapshot) {
        const fresh = createEmptyIncrementalState();
        Object.keys(state).forEach(key => delete state[key]);
        Object.assign(state, fresh);
        return state;
    }

    state.lastTime = snapshot.lastTime;
    state.length = snapshot.length;
    const ema = {};
    Object.keys(snapshot.ema).forEach((key) => { ema[key] = Object.assign({}, snapshot.ema[key]); });
    state.ema = ema;
    const rsi = {};
    Object.keys(snapshot.rsi).forEach((key) => { rsi[key] = Object.assign({}, snapshot.rsi[key]); });
    state.rsi = rsi;
    state.macd = Object.assign({}, snapshot.macd);
    return state;
}

function updateExplicitMacdState(candle, index, state) {
    const macdState = state.macd;
    const fastK = 2 / (macdState.fastPeriod + 1);
    const slowK = 2 / (macdState.slowPeriod + 1);
    macdState.fast = Number.isFinite(macdState.fast) ? (candle.close - macdState.fast) * fastK + macdState.fast : candle.close;
    macdState.slow = Number.isFinite(macdState.slow) ? (candle.close - macdState.slow) * slowK + macdState.slow : candle.close;

    const macd = index < macdState.slowPeriod - 1 ? 0 : macdState.fast - macdState.slow;
    const signalK = 2 / (macdState.signalPeriod + 1);
    macdState.signal = Number.isFinite(macdState.signal) ? (macd - macdState.signal) * signalK + macdState.signal : macd;
    const value = macd - macdState.signal;
    const point = { time: candle.time, value, macd, signal: macdState.signal };
    AppState.indicators.macd.push(point);
    return point;
}

function rebuildExplicitIndicatorStateFromCandles(data) {
    resetIncrementalIndicatorState();
    EXPLICIT_EMA_PERIODS.forEach(period => { AppState.indicators[`e${period}`] = []; });
    AppState.indicators.rsi = [];
    AppState.indicators.rsi21 = [];
    AppState.indicators.macd = [];

    const state = ensureIncrementalState();
    for (let i = 0; i < data.length; i++) {
        EXPLICIT_EMA_PERIODS.forEach(period => updateExplicitEmaState(data[i], state, period, `e${period}`));
        EXPLICIT_RSI_PERIODS.forEach(period => updateExplicitRsiState(data, i, state, period, period === 14 ? 'rsi' : `rsi${period}`));
        updateExplicitMacdState(data[i], i, state);
        state.length = i + 1;
        state.lastTime = data[i].time;
        setSnapshot(state, i, snapshotExplicitState(state));
    }
    syncRsiLookup();
    return state;
}

function calcADX(data, period) {
    if (!data || data.length <= period) return []; 
    let res = [];
    let tr = [];
    let pDM = [];
    let mDM = [];
    
    for (let i = 1; i < data.length; i++) { 
        let h = data[i].high;
        let l = data[i].low;
        let pC = data[i-1].close;
        let pH = data[i-1].high;
        let pL = data[i-1].low; 
        
        tr.push(Math.max(h - l, Math.abs(h - pC), Math.abs(l - pC))); 
        let mU = h - pH;
        let mD = pL - l; 
        
        pDM.push(mU > 0 && mU > mD ? mU : 0); 
        mDM.push(mD > 0 && mD > mU ? mD : 0); 
    }
    
    function smooth(arr, len) { 
        let s = [];
        let sum = 0; 
        for(let i=0; i<len; i++) {
            sum += arr[i]; 
        }
        s.push(sum); 
        for(let i=len; i<arr.length; i++) {
            s.push(s[s.length-1] - (s[s.length-1]/len) + arr[i]); 
        }
        return s; 
    }
    
    if(tr.length < period) return data.map(d=>({time:d.time, value: 0})); 
    
    let sTR = smooth(tr, period);
    let spDM = smooth(pDM, period);
    let smDM = smooth(mDM, period);
    let dx = [];
    
    for (let i = 0; i < sTR.length; i++) { 
        let dP = sTR[i] > 0 ? (spDM[i] / sTR[i]) * 100 : 0;
        let dM = sTR[i] > 0 ? (smDM[i] / sTR[i]) * 100 : 0;
        let sumDI = dP + dM; 
        dx.push(sumDI === 0 ? 0 : (Math.abs(dP - dM) / sumDI) * 100); 
    }
    
    let adxS = smooth(dx, period);
    let p = 0; 
    for(let i=0; i<data.length; i++) {
        res.push({time: data[i].time, value: i < 2 * period ? 0 : adxS[p++] || 0}); 
    }
    return res;
}

function calcVWAP(data) { 
    let res = [];
    let sumPV = 0;
    let sumV = 0; 
    for (let i = 0; i < data.length; i++) { 
        if (i > 0 && new Date(data[i-1].time * 1000).getUTCDay() !== new Date(data[i].time * 1000).getUTCDay()) { 
            sumPV = 0; 
            sumV = 0; 
        } 
        let tP = (data[i].high + data[i].low + data[i].close) / 3; 
        sumPV += tP * data[i].vol; 
        sumV += data[i].vol; 
        res.push({ time: data[i].time, value: sumV === 0 ? data[i].close : safeDiv(sumPV, sumV) }); 
    } 
    return res; 
}

function calcST(data, period = 21, factor = 1.618) {
    if (!data || data.length === 0) {
        return { up: [], down: [], raw: [] };
    }
    
    let up = [];
    let down = [];
    let raw = [];
    let longStop = 0;
    let shortStop = 0;
    let trend = 1;
    let atrArr = [];

    for (let i = 0; i < data.length; i++) {
        let tr = i === 0 ? data[i].high - data[i].low : 
                 Math.max(data[i].high - data[i].low, 
                 Math.abs(data[i].high - data[i-1].close), 
                 Math.abs(data[i].low - data[i-1].close));
        atrArr.push(tr);
    }

    let smoothAtr = 0;
    for (let i = 0; i < data.length; i++) {
        if (i < period) {
            smoothAtr = atrArr.slice(0, i + 1).reduce((a, b) => a + b, 0) / (i + 1);
        } else {
            smoothAtr = (smoothAtr * (period - 1) + atrArr[i]) / period;
        }

        let mid = (data[i].high + data[i].low) / 2;
        let upperBand = mid + (factor * smoothAtr);
        let lowerBand = mid - (factor * smoothAtr);

        if (i > 0) {
            longStop = data[i-1].close > longStop ? Math.max(lowerBand, longStop) : lowerBand;
            shortStop = data[i-1].close < shortStop ? Math.min(upperBand, shortStop) : upperBand;

            let prevTrend = trend;
            if (data[i].close > shortStop) {
                trend = 1;
            } else if (data[i].close < longStop) {
                trend = -1;
            }

            let currentST = trend === 1 ? longStop : shortStop;
            raw.push({ time: data[i].time, value: currentST, trend: trend });

            if (trend === 1) {
                up.push({ time: data[i].time, value: currentST });
                down.push({ time: data[i].time }); 
            } else {
                down.push({ time: data[i].time, value: currentST });
                up.push({ time: data[i].time }); 
            }
        } else {
            longStop = lowerBand; 
            shortStop = upperBand;
            raw.push({ time: data[i].time, value: lowerBand, trend: 1 });
            up.push({ time: data[i].time, value: lowerBand });
            down.push({ time: data[i].time });
        }
    }
    return { up, down, raw };
}

function calcRSI(data, period) { 
    if (!data || data.length === 0) return []; 
    let res = [];
    let gain = 0;
    let loss = 0;
    let limit = Math.min(period, data.length); 
    
    for (let i = 0; i < limit; i++) {
        res.push({time: data[i].time, value: 50});
    }
    if (data.length <= period) return res; 
    
    for (let i = 1; i <= period; i++) { 
        let change = data[i].close - data[i-1].close; 
        if (change > 0) gain += change; else loss -= change; 
    } 
    
    let avgGain = safeDiv(gain, period);
    let avgLoss = safeDiv(loss, period); 
    
    for (let i = period; i < data.length; i++) { 
        if (i > period) { 
            let change = data[i].close - data[i-1].close; 
            avgGain = (avgGain * (period - 1) + (change > 0 ? change : 0)) / period; 
            avgLoss = (avgLoss * (period - 1) + (change < 0 ? -change : 0)) / period; 
        } 
        let rs = avgLoss === 0 ? 100 : safeDiv(avgGain, avgLoss); 
        res.push({ time: data[i].time, value: avgLoss === 0 ? 100 : 100 - (100 / (1 + rs)) }); 
    } 
    return res; 
}

function calcStochRSI(rsiData, period, smoothK, smoothD) { 
    if (rsiData.length === 0) return { k: [], d: [] }; 
    let stoch = []; 
    for (let i = 0; i < rsiData.length; i++) { 
        if (i < period - 1) { 
            stoch.push({ time: rsiData[i].time, value: 50 }); 
            continue; 
        } 
        let slice = rsiData.slice(i - period + 1, i + 1).map(r => r.value);
        let max = Math.max(...slice);
        let min = Math.min(...slice); 
        stoch.push({ time: rsiData[i].time, value: max === min ? 50 : ((rsiData[i].value - min) / (max - min)) * 100 }); 
    } 
    let kA = calcSMA(stoch, smoothK, 'value');
    let k = kA.map((v, i) => ({ time: stoch[i].time, value: v }));
    let dA = calcSMA(k, smoothD, 'value');
    let d = dA.map((v, i) => ({ time: k[i].time, value: v })); 
    return { k, d }; 
}

function calcWR(data, period) { 
    let res = []; 
    for (let i = 0; i < data.length; i++) { 
        if (i < period - 1) { 
            res.push({ time: data[i].time, value: -50 }); 
            continue; 
        } 
        let slice = data.slice(i - period + 1, i + 1);
        let maxH = Math.max(...slice.map(c => c.high));
        let minL = Math.min(...slice.map(c => c.low)); 
        res.push({ time: data[i].time, value: maxH === minL ? -50 : ((maxH - data[i].close) / (maxH - minL)) * -100 }); 
    } 
    return res; 
}

function calcBB(data, period=21, mult=1.618) { 
    let res = []; 
    for(let i=0; i<data.length; i++){ 
        if(i<period-1) { 
            res.push({time: data[i].time, upper: data[i].close, lower: data[i].close, middle: data[i].close}); 
            continue; 
        } 
        let slice = data.slice(i - period + 1, i + 1);
        let mean = slice.reduce((a,b)=>a+b.close, 0)/period;
        let variance = slice.reduce((a,b)=>a+Math.pow(b.close-mean, 2), 0)/period;
        let std = Math.sqrt(variance); 
        res.push({time: data[i].time, upper: mean + mult*std, lower: mean - mult*std, middle: mean}); 
    } 
    return res; 
}

function calcDonchian(data, period=21) { 
    let res = []; 
    for(let i=0; i<data.length; i++){ 
        if(i<period-1) { 
            res.push({time: data[i].time, upper: data[i].high, lower: data[i].low, middle: (data[i].high+data[i].low)/2}); 
            continue; 
        } 
        let slice = data.slice(i - period + 1, i + 1);
        let maxH = Math.max(...slice.map(c=>c.high));
        let minL = Math.min(...slice.map(c=>c.low)); 
        res.push({time: data[i].time, upper: maxH, lower: minL, middle: (maxH+minL)/2}); 
    } 
    return res; 
}

function calcOBV_CVD(data) { 
    let obv = [];
    let cvd = [];
    let obvSum = 0;
    let cvdSum = 0; 
    for(let i=0; i<data.length; i++){ 
        if(i>0) { 
            if(data[i].close > data[i-1].close) {
                obvSum += data[i].vol; 
            } else if(data[i].close < data[i-1].close) {
                obvSum -= data[i].vol; 
            }
        } 
        let buyVol = data[i].takerVol || (data[i].vol * 0.5);
        let sellVol = data[i].vol - buyVol; 
        cvdSum += (buyVol - sellVol); 
        obv.push({time: data[i].time, value: obvSum}); 
        cvd.push({time: data[i].time, value: cvdSum}); 
    } 
    return { obv, cvd }; 
}

function calcPSAR(data, step = 0.02, max = 0.2) { 
    let res = []; 
    if(data.length === 0) return res; 
    let isUp = true;
    let ep = data[0].high;
    let sar = data[0].low;
    let af = step; 
    
    for(let i=0; i<data.length; i++) { 
        if(i===0){ 
            res.push({time: data[i].time, value: sar}); 
            continue; 
        } 
        let pS = sar; 
        sar = pS + af * (ep - pS); 
        
        if(isUp) { 
            if(data[i].low < sar) { 
                isUp = false; 
                sar = ep; 
                ep = data[i].low; 
                af = step; 
            } else { 
                if(data[i].high > ep) { 
                    ep = data[i].high; 
                    af = Math.min(af + step, max); 
                } 
                sar = Math.min(sar, data[i-1].low, i>1 ? data[i-2].low : data[i-1].low); 
            } 
        } else { 
            if(data[i].high > sar) { 
                isUp = true; 
                sar = ep; 
                ep = data[i].high; 
                af = step; 
            } else { 
                if(data[i].low < ep) { 
                    ep = data[i].low; 
                    af = Math.min(af + step, max); 
                } 
                sar = Math.max(sar, data[i-1].high, i>1 ? data[i-2].high : data[i-1].high); 
            } 
        } 
        res.push({time: data[i].time, value: sar, trend: isUp ? 1 : -1}); 
    } 
    return res; 
}

function calcMFI(data, period=21) { 
    let res = []; 
    for(let i=0; i<data.length; i++){ 
        if(i < period) { 
            res.push({time: data[i].time, value: 50}); 
            continue; 
        } 
        let posMF = 0;
        let negMF = 0; 
        for(let j = i - period + 1; j <= i; j++){ 
            let typ = (data[j].high + data[j].low + data[j].close)/3;
            let pTyp = (data[j-1].high + data[j-1].low + data[j-1].close)/3;
            let mf = typ * data[j].vol; 
            
            if(typ > pTyp) {
                posMF += mf; 
            } else if(typ < pTyp) {
                negMF += mf; 
            }
        } 
        let ratio = negMF === 0 ? 100 : posMF / negMF; 
        res.push({time: data[i].time, value: 100 - (100 / (1 + ratio))}); 
    } 
    return res; 
}

function calcLinReg(data, period=21) { 
    let res = []; 
    for(let i=0; i<data.length; i++){ 
        if(i<period-1) { 
            res.push({time: data[i].time, value: data[i].close, slope:0}); 
            continue; 
        } 
        let sX = 0;
        let sY = 0;
        let sXY = 0;
        let sXX = 0; 
        for(let j=0; j<period; j++) { 
            let x = j;
            let y = data[i - period + 1 + j].close; 
            sX += x; 
            sY += y; 
            sXY += x*y; 
            sXX += x*x; 
        } 
        let slope = (period * sXY - sX * sY) / (period * sXX - sX * sX);
        let intercept = (sY - slope * sX) / period; 
        res.push({time: data[i].time, value: intercept + slope * (period - 1), slope: slope}); 
    } 
    return res; 
}

function calcVolOsc(data, fast=8, slow=21) { 
    let res = [];
    let fSMA = calcSMA(data, fast, 'vol');
    let sSMA = calcSMA(data, slow, 'vol'); 
    for(let i=0; i<data.length; i++) {
        res.push({time: data[i].time, value: sSMA[i] === 0 ? 0 : ((fSMA[i] - sSMA[i])/sSMA[i])*100}); 
    }
    return res; 
}

function calcIchimoku(data, tenkan=8, kijun=21, senkou=55) { 
    let res = [];
    let getHL2 = (slice) => { 
        if(!slice.length) return 0; 
        return (Math.max(...slice.map(c=>c.high)) + Math.min(...slice.map(c=>c.low)))/2; 
    }; 
    for(let i=0; i<data.length; i++){ 
        let tVal = getHL2(data.slice(Math.max(0, i-tenkan+1), i+1));
        let kVal = getHL2(data.slice(Math.max(0, i-kijun+1), i+1));
        let spanB = getHL2(data.slice(Math.max(0, i-senkou+1), i+1)); 
        res.push({time: data[i].time, tenkan: tVal, kijun: kVal, spanA: (tVal + kVal)/2, spanB: spanB}); 
    } 
    return res; 
}

function calcPivots(data) { 
    let res = [];
    let period = AppState.g_tf === '1m' ? 1440 : (AppState.g_tf === '5m' ? 288 : (AppState.g_tf === '1h' ? 24 : 96)); 
    for(let i=0; i<data.length; i++){ 
        if(i < period) { 
            res.push({time: data[i].time, p: data[i].close, r1: data[i].close, s1: data[i].close}); 
            continue; 
        } 
        let slice = data.slice(i-period, i);
        let p = (Math.max(...slice.map(c=>c.high)) + Math.min(...slice.map(c=>c.low)) + slice[slice.length-1].close) / 3; 
        res.push({time: data[i].time, p, r1: (2 * p) - Math.min(...slice.map(c=>c.low)), s1: (2 * p) - Math.max(...slice.map(c=>c.high))}); 
    } 
    return res; 
}

// Bugfix v4.4: Solusi string grouping untuk Koin Micin
function calcPOC(data, lookback=100) { 
    let res = []; 
    for(let i=0; i<data.length; i++){ 
        if(i<lookback) { 
            res.push({time: data[i].time, value: data[i].close}); 
            continue; 
        } 
        let slice = data.slice(i-lookback, i);
        let bins = {};
        let maxVol = 0;
        let poc = data[i].close;
        
        // Menghindari tabrakan float micin
        let step = data[i].close * 0.001; 
        if (step === 0) step = 0.00000001;

        slice.forEach(c => { 
            let binKey = (Math.round(c.close / step) * step).toFixed(8); 
            bins[binKey] = (bins[binKey] || 0) + c.vol; 
            if(bins[binKey] > maxVol) { 
                maxVol = bins[binKey]; 
                poc = parseFloat(binKey); 
            } 
        }); 
        res.push({time: data[i].time, value: poc}); 
    } 
    return res; 
}

const DERIVED_INDICATOR_KEYS = [
    'st', 'stUp', 'stDown', 'adx', 'stochK', 'stochD', 'wr', 'vwap', 'bb',
    'donchian', 'obv', 'cvd', 'psar', 'mfi', 'linreg', 'volosc', 'ichimoku',
    'pivots', 'poc'
];
const DERIVED_INDICATOR_TAIL_LIMIT = 260;

function calculateDerivedIndicatorSets(data) {
    const st = calcST(data, 21, 1.618);
    const stoch = calcStochRSI(AppState.indicators.rsi, 14, 3, 3);
    const obvcvd = calcOBV_CVD(data);
    return {
        st: st.raw,
        stUp: st.up,
        stDown: st.down,
        adx: calcADX(data, 14),
        stochK: stoch.k,
        stochD: stoch.d,
        wr: calcWR(data, 14),
        vwap: calcVWAP(data),
        bb: calcBB(data, 21, 1.618),
        donchian: calcDonchian(data, 21),
        obv: obvcvd.obv,
        cvd: obvcvd.cvd,
        psar: calcPSAR(data, 0.02, 0.2),
        mfi: calcMFI(data, 21),
        linreg: calcLinReg(data, 21),
        volosc: calcVolOsc(data, 8, 21),
        ichimoku: calcIchimoku(data, 8, 21, 55),
        pivots: calcPivots(data),
        poc: calcPOC(data, 100)
    };
}

function calculateVolumeState(data) {
    let vSma = [];
    let atrArr = [];
    let sumVol = 0;
    const highs = [];
    const lows = [];

    for (let i = 0; i < data.length; i++) {
        sumVol += data[i].vol;
        if (i >= 20) {
            sumVol -= data[i-20].vol;
        }
        vSma.push(i >= 19 ? sumVol/20 : sumVol/(i+1));

        let atr = i === 0 ? data[i].high - data[i].low :
                  Math.max(data[i].high - data[i].low,
                  Math.abs(data[i].high - data[i-1].close),
                  Math.abs(data[i].low - data[i-1].close));
        atrArr.push(atr);

        if (i > 4 && i < data.length - 4) {
            let isPH = true;
            let isPL = true;
            for (let j = 1; j <= 4; j++) {
                if (data[i].high <= data[i-j].high || data[i].high <= data[i+j].high) isPH = false;
                if (data[i].low >= data[i-j].low || data[i].low >= data[i+j].low) isPL = false;
            }
            if (isPH) highs.push({time: data[i].time, val: data[i].high});
            if (isPL) lows.push({time: data[i].time, val: data[i].low});
        }
    }

    let atrSum = 0;
    const atrSMA = [];
    for (let i = 0; i < atrArr.length; i++) {
        atrSum += atrArr[i];
        if (i >= 14) {
            atrSum -= atrArr[i-14];
        }
        atrSMA.push(i >= 13 ? atrSum/14 : atrSum/(i+1));
    }

    return { vSma, atrSMA, highs, lows };
}

function applyFullDerivedIndicators(data) {
    const derived = calculateDerivedIndicatorSets(data);
    DERIVED_INDICATOR_KEYS.forEach((key) => { AppState.indicators[key] = derived[key] || []; });
    const volumeState = calculateVolumeState(data);
    AppState.volSMA = volumeState.vSma;
    AppState.atrSMA = volumeState.atrSMA;
    AppState.swings.highs = volumeState.highs;
    AppState.swings.lows = volumeState.lows;
}

function upsertLastIndicatorPoint(key, point, lastIndex, lastTime) {
    const target = AppState.indicators[key];
    if (!Array.isArray(target)) return;
    while (target.length > lastIndex) target.pop();
    if (point && point.time === lastTime) target[lastIndex] = point;
}

function updateDerivedIndicatorsIncremental(data) {
    const lastIndex = data.length - 1;
    const lastTime = data[lastIndex].time;
    const tailStart = Math.max(0, data.length - DERIVED_INDICATOR_TAIL_LIMIT);
    const tail = data.slice(tailStart);
    const derived = calculateDerivedIndicatorSets(tail);

    // Hanya titik terakhir yang diperbarui saat tick realtime agar CPU tetap stabil.
    DERIVED_INDICATOR_KEYS.forEach((key) => {
        const series = derived[key] || [];
        upsertLastIndicatorPoint(key, series[series.length - 1], lastIndex, lastTime);
    });

    const startVol = Math.max(0, data.length - 40);
    const volumeState = calculateVolumeState(data.slice(startVol));
    const volPoint = volumeState.vSma[volumeState.vSma.length - 1];
    const atrPoint = volumeState.atrSMA[volumeState.atrSMA.length - 1];
    while (AppState.volSMA.length > lastIndex) AppState.volSMA.pop();
    while (AppState.atrSMA.length > lastIndex) AppState.atrSMA.pop();
    AppState.volSMA[lastIndex] = volPoint;
    AppState.atrSMA[lastIndex] = atrPoint;
}

function pruneIncrementalIndicatorState(maxLength) {
    const state = ensureIncrementalState();
    // Snapshots are keyed by absolute index; dropping entries below the new
    // window start keeps the rolling store aligned after a front prune.
    state.length = Math.min(state.length, maxLength);
    if (AppState.candles.length > 0) state.lastTime = AppState.candles[AppState.candles.length - 1].time;
}

function calculateAllIndicators() {
    const data = AppState.candles;
    if (data.length === 0) return;

    rebuildExplicitIndicatorStateFromCandles(data);
    applyFullDerivedIndicators(data);
    syncRsiLookup();
}

function calculateIndicatorsIncremental() {
    const data = AppState.candles;
    if (!data || data.length === 0) {
        resetIncrementalIndicatorState();
        return;
    }

    let state = ensureIncrementalState();
    const lastIndex = data.length - 1;
    const lastCandle = data[lastIndex];
    const canAppend = state.length === data.length - 1;
    const canReplaceLast = state.length === data.length && state.lastTime === lastCandle.time;

    if (canReplaceLast) {
        const previousSnapshot = getSnapshot(state, lastIndex - 1);
        restoreExplicitStateSnapshot(state, previousSnapshot);
        dropSnapshotsFrom(state, lastIndex);
        AppState.indicators.e21.pop();
        AppState.indicators.e55.pop();
        AppState.indicators.e200.pop();
        AppState.indicators.rsi.pop();
        AppState.indicators.rsi21.pop();
        AppState.indicators.macd.pop();
    } else if (!canAppend) {
        // Asumsi: gap besar berarti pair/timeframe/history berubah, jadi state eksplisit direbuild.
        rebuildExplicitIndicatorStateFromCandles(data);
    }

    state = ensureIncrementalState();
    if (state.length === data.length - 1) {
        EXPLICIT_EMA_PERIODS.forEach(period => updateExplicitEmaState(lastCandle, state, period, `e${period}`));
        EXPLICIT_RSI_PERIODS.forEach(period => updateExplicitRsiState(data, lastIndex, state, period, period === 14 ? 'rsi' : `rsi${period}`));
        updateExplicitMacdState(lastCandle, lastIndex, state);
        state.length = data.length;
        state.lastTime = lastCandle.time;
        setSnapshot(state, lastIndex, snapshotExplicitState(state));
    }

    updateDerivedIndicatorsIncremental(data);
    syncRsiLookup();
}
