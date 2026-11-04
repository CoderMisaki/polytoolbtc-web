(function attachIntelligenceEngine(root) {
    const safeDiv = (a, b) => (!b || b === 0) ? 0 : a / b;
    const IntelligenceEngine = {
    buildMarketState(idx, data, ind) {
        const c = data[idx]; 
        let atr = AppState.atrSMA[idx] ? AppState.atrSMA[idx] : (c.high - c.low);
        let atrRank = atr > 0 ? safeDiv((c.high - c.low), atr) : 1;
        
        let volRegime = atrRank > 1.2 ? "EXPANSION" : (atrRank < 0.6 ? "CHOP" : "NORMAL");
        let volAvg = AppState.volSMA[idx] || c.vol;
        let liqRegime = c.vol > volAvg * 1.5 ? "HEAVY" : (c.vol < volAvg * 0.5 ? "THIN" : "NORMAL");
        
        let e200 = ind.e200[idx] ? ind.e200[idx].value : c.close;
        let trendRegime = "SIDEWAYS";
        
        if (c.close > e200 && ind.st[idx] && ind.st[idx].trend === 1) trendRegime = "STRONG_UP"; 
        else if (c.close < e200 && ind.st[idx] && ind.st[idx].trend === -1) trendRegime = "STRONG_DOWN";
        
        return { regime: trendRegime, volatility: volRegime, liquidity: liqRegime, atr: atr };
    },

    analyzeSubModels(idx, data, ind, f, state) {
        let scores = { trend: 0, meanRev: 0, breakout: 0, liquidity: 0, whale: 0 };
        let reasons = []; 
        const c = data[idx]; 
        let e200 = ind.e200[idx] ? ind.e200[idx].value : c.close;
        
        const checkStatus = (key, raw) => AI_STATS[key].status === 'DISABLED' ? 0 : raw * (AI_STATS[key].status === 'BOOSTED' ? 1.5 : 1);

        let rawLiq = 0;
        if (idx > 3) { 
            let c2 = data[idx-2]; 
            if (c2.high < c.low) { rawLiq += 20; reasons.push("Bull FVG"); } 
            if (c2.low > c.high) { rawLiq -= 20; reasons.push("Bear FVG"); } 
        }
        
        let lookback = Math.max(0, idx-10);
        let minL = Math.min(...data.slice(lookback, idx).map(x=>x.low));
        let maxH = Math.max(...data.slice(lookback, idx).map(x=>x.high));
        
        if (c.low < minL && c.close > minL && c.close > c.open) { rawLiq += 30; reasons.push("Stop Hunt Low"); }
        if (c.high > maxH && c.close < maxH && c.close < c.open) { rawLiq -= 30; reasons.push("Stop Hunt High"); }
        if (ind.poc[idx] && Math.abs(c.close - ind.poc[idx].value)/c.close < 0.005) { rawLiq += 10; reasons.push("POC Interaction"); }
        scores.liquidity = checkStatus('liquidity', rawLiq);

        let rawWhale = 0;
        let isPriceUp = c.close > c.open;
        
        if (isPriceUp && f.smart < 0.45) { rawWhale -= 30; reasons.push("Smart Sell Div"); } 
        if (!isPriceUp && f.smart > 0.55) { rawWhale += 30; reasons.push("Smart Buy Div"); }
        if (f.funding > 0.005 && state.regime !== 'STRONG_UP') { rawWhale -= 20; reasons.push("Fund Trap Squeeze"); } 
        if (f.funding < -0.005 && state.regime !== 'STRONG_DOWN') { rawWhale += 20; reasons.push("Fund Trap Bounce"); }
        
        if(idx > 5 && ind.cvd[idx] && ind.cvd[idx-5]) {
            if(ind.cvd[idx].value > ind.cvd[idx-5].value && c.close <= data[idx-5].close) { rawWhale += 20; reasons.push("CVD Bull Div"); }
            if(ind.cvd[idx].value < ind.cvd[idx-5].value && c.close >= data[idx-5].close) { rawWhale -= 20; reasons.push("CVD Bear Div"); }
        }
        if(idx > 5 && ind.obv[idx] && ind.obv[idx-5]) { 
            if(ind.obv[idx].value > ind.obv[idx-5].value) rawWhale += 10; 
            else rawWhale -= 10; 
        }
        scores.whale = checkStatus('whale', rawWhale);

        let rawMean = 0;
        let vwap = ind.vwap[idx] ? ind.vwap[idx].value : c.close;
        let vwapDist = safeDiv((c.close - vwap), vwap);
        
        if (vwapDist > 0.015) { rawMean -= 25; reasons.push("VWAP OB"); } 
        else if (vwapDist < -0.015) { rawMean += 25; reasons.push("VWAP OS"); }
        
        let rsi = ind.rsi[idx] ? ind.rsi[idx].value : 50;
        if (rsi > 70) { rawMean -= 30; reasons.push("RSI OB"); } 
        else if (rsi < 30) { rawMean += 30; reasons.push("RSI OS"); }
        
        if(ind.bb[idx]) { 
            if(c.close > ind.bb[idx].upper) { rawMean -= 20; reasons.push("BB Upper Hit"); } 
            if(c.close < ind.bb[idx].lower) { rawMean += 20; reasons.push("BB Lower Hit"); } 
        }
        if(ind.mfi[idx]) { 
            if(ind.mfi[idx].value > 80) { rawMean -= 15; reasons.push("MFI Overbought"); } 
            if(ind.mfi[idx].value < 20) { rawMean += 15; reasons.push("MFI Oversold"); } 
        }
        if (state.regime.includes("STRONG")) rawMean = 0; 
        scores.meanRev = checkStatus('meanRev', rawMean);

        let rawTrend = 0;
        if (ind.st[idx] && ind.st[idx-1]) {
            if (ind.st[idx].trend === 1) rawTrend += 20; else rawTrend -= 20;
            if (ind.st[idx-1].trend !== ind.st[idx].trend) { rawTrend *= 1.5; reasons.push("ST Flip"); }
        }
        if (c.close > e200) rawTrend += 10; else rawTrend -= 10;
        
        let adx = ind.adx[idx] ? ind.adx[idx].value : 0; 
        let macd = ind.macd[idx];
        let prevMacd = ind.macd[idx-1];
        if (macd && prevMacd) { 
            if (macd.value > 0 && prevMacd.value <= 0) { rawTrend += 15; reasons.push("MACD Bull Cross"); } 
            if (macd.value < 0 && prevMacd.value >= 0) { rawTrend -= 15; reasons.push("MACD Bear Cross"); } 
        }
        
        if(ind.psar[idx] && c.close > ind.psar[idx].value) rawTrend += 10; else rawTrend -= 10;
        if(ind.linreg[idx] && ind.linreg[idx].slope > 0) rawTrend += 10; else rawTrend -= 10;
        if(ind.ichimoku[idx] && c.close > ind.ichimoku[idx].kijun) rawTrend += 10; else rawTrend -= 10;
        
        if (state.volatility === "CHOP") rawTrend *= 0.5; 
        scores.trend = checkStatus('trend', rawTrend);

        let rawBrk = 0;
        let rH = AppState.swings.highs.filter(s => s.time < c.time).slice(-1)[0];
        let rL = AppState.swings.lows.filter(s => s.time < c.time).slice(-1)[0];
        
        if (rH && c.close > rH.val && isPriceUp && state.liquidity === "HEAVY") { 
            rawBrk += 25; if (adx > 25) rawBrk *= 1.5; reasons.push("Vol Breakout Bull"); 
        }
        if (rL && c.close < rL.val && !isPriceUp && state.liquidity === "HEAVY") { 
            rawBrk -= 25; if (adx > 25) rawBrk *= 1.5; reasons.push("Vol Breakout Bear"); 
        }
        if(ind.volosc[idx] && ind.volosc[idx].value > 20) rawBrk += 10;
        if(ind.pivots[idx] && c.close > ind.pivots[idx].r1) { rawBrk += 15; reasons.push("R1 Breakout"); }
        if(ind.pivots[idx] && c.close < ind.pivots[idx].s1) { rawBrk -= 15; reasons.push("S1 Breakdown"); }
        scores.breakout = checkStatus('breakout', rawBrk);

        return { scores, reasons, adx };
    },

    analyze(idx) {
        const f = AppState.fusion || AppState.fusionBase;
        const data = AppState.candles;
        const ind = AppState.indicators;
        const c = data[idx];
        const session = getMarketSession();
        
        if (idx < 200 || !ind.e200[idx]) {
            return { score: 0, signal: "WAIT", type: "WAIT", risk: "MED", prob: 0, insightArr: ["Init Warmup..."], regime: "ANALYSING", volRegime: "NORMAL", session: session, fData: f, dominantStrategy: "NONE", atr: 0, age: 0, neural: null };
        }

        let state = this.buildMarketState(idx, data, ind); 
        AppState.marketState = state; 
        
        let models = this.analyzeSubModels(idx, data, ind, f, state);
        
        let rawScore = (models.scores.trend * AI_STATS.trend.w) + 
                       (models.scores.meanRev * AI_STATS.meanRev.w) + 
                       (models.scores.breakout * AI_STATS.breakout.w) + 
                       (models.scores.liquidity * AI_STATS.liquidity.w) + 
                       (models.scores.whale * AI_STATS.whale.w);
                       
        let dominantStrategy = Object.keys(models.scores).reduce((a, b) => Math.abs(models.scores[a]) > Math.abs(models.scores[b]) ? a : b);
        let reason = [...new Set(models.reasons)].slice(0, 3); 

        let mtf1h = AppState.mtf['1h'];
        let context = (mtf1h === 'UP' && c.close > ind.e200[idx].value) ? "BULLISH" : ((mtf1h === 'DOWN' && c.close < ind.e200[idx].value) ? "BEARISH" : "MIXED");
        
        if (context === "BULLISH" && rawScore < 0) rawScore *= 0.5; 
        if (context === "BEARISH" && rawScore > 0) rawScore *= 0.5;
        
        rawScore = Math.max(-100, Math.min(100, rawScore)); 
        AppState.smoothedScore = (AppState.smoothedScore * 0.8) + (rawScore * 0.2);
        let score = AppState.smoothedScore;
        // Animal Neural layer: bounded ±6 nudge from the collective Meta Brain.
        // The existing engine stays dominant; neural only refines the score.
        let neuralInfo = null;
        try {
            const NeuralSys = (typeof AnimalNeuralSystem !== 'undefined')
                ? AnimalNeuralSystem
                : ((typeof window !== 'undefined' && window.AnimalNeuralSystem) ? window.AnimalNeuralSystem : null);
            if (NeuralSys && typeof NeuralSys.getInfluence === 'function') {
                neuralInfo = NeuralSys.getInfluence();
                if (neuralInfo && neuralInfo.active && Number.isFinite(neuralInfo.bias)) {
                    score += Math.max(-1, Math.min(1, neuralInfo.bias)) * 6;
                    score = Math.max(-100, Math.min(100, score));
                }
            }
        } catch (e) { neuralInfo = null; }
        let prob = Math.abs(score) >= 10 ? 100 / (1 + Math.exp(-Math.abs(score)/20)) : 0; 
        AppState.smoothedProb = (AppState.smoothedProb * 0.9) + (prob * 0.1); 

        let risk = safeDiv(c.high - c.low, c.close) < 0.002 ? "LOW" : "HIGH";
        let sig = "WAIT";
        let type = "WAIT";
        
        let threshExecute = AppState.aiMode === 'CONS' ? 45 : 30;
        let volAvg = AppState.volSMA[idx] || 1;
        let isVolumeStrong = c.vol > (volAvg * 1.1);
        let trendAligned = false;
        
        if (rawScore > 0 && AppState.mtf['1h'] === 'UP') trendAligned = true;
        if (rawScore < 0 && AppState.mtf['1h'] === 'DOWN') trendAligned = true;

        if (models.adx < 25) {
            sig = "WAIT"; type = "WAIT"; reason.push("Entropy Guard (ADX < 25)");
        } else if (Math.abs(score) >= threshExecute && trendAligned && isVolumeStrong) {
            if (score > 0) { sig = "STRONG BUY"; type = "EXECUTE"; } 
            else { sig = "STRONG SELL"; type = "EXECUTE"; }
        } else if (Math.abs(score) >= (threshExecute * 0.7)) {
            sig = "WAITING CONFLUENCE"; type = "WAIT";
        } else {
            sig = "WAIT"; type = "WAIT";
        }

        if (!trendAligned && Math.abs(score) >= threshExecute) reason.push("Blocked by MTF Trend");
        if (!isVolumeStrong && Math.abs(score) >= threshExecute) reason.push("Low Volume Warning");
        if (reason.length === 0) reason.push("Flow Neutral");
        if (neuralInfo && neuralInfo.active && neuralInfo.summary) reason.unshift(neuralInfo.summary);
        // Neural Risk Gate: a HARD block (stale data, no quorum, extreme
        // risk) downgrades EXECUTE to WAIT. Soft warnings never block.
        if (neuralInfo && neuralInfo.active && neuralInfo.hardBlock && type === "EXECUTE") {
            type = "WAIT"; sig = "WAITING CONFLUENCE";
            reason.push("Neural Gate: " + (neuralInfo.blockReason || "NO_TRADE"));
        }
        
        let age = ((sig === "STRONG BUY" || sig === "STRONG SELL") && AppState.live.prevSignal === sig) ? AppState.live.age + 1 : 0;
        if (age > 2) reason.push(`Signal Age: ${age}`);

        let activePos = FuturesEngine.state.positions.find(p => p.pair === AppState.g_pair);
        if (activePos) {
            let pnlR = activePos.type === 'LONG' ? (c.close - activePos.entryPrice) : (activePos.entryPrice - c.close);
            let shouldClose = false;
            if (activePos.type === 'LONG' && score <= -threshExecute) shouldClose = true;
            if (activePos.type === 'SHORT' && score >= threshExecute) shouldClose = true;
            
            if (shouldClose) {
                let cCol = pnlR >= 0 ? '#4ade80' : '#ef4444'; 
                let existingCl = AppState.aiSignalMarkers.filter(m => m.pair === AppState.g_pair && m.text === 'CLOSE').slice(-1)[0];
                if (!existingCl || (c.time - existingCl.time > 1800)) {
                    AppState.aiSignalMarkers.push({ pair: AppState.g_pair, time: c.time, position: 'inBar', color: cCol, shape: 'circle', text: 'CLOSE' });
                }
            }
        }

        return { score, signal: sig, type, risk, insightArr: reason, prob: AppState.smoothedProb, regime: state.regime, volRegime: state.volatility, session, fData: f, dominantStrategy, atr: state.atr, age, neural: neuralInfo || null };
    }
};

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = IntelligenceEngine;
    }
    if (root) {
        root.IntelligenceEngine = IntelligenceEngine;
    }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
