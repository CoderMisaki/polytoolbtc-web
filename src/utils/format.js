function safeDiv(a, b) { 
    if (b === 0 || isNaN(a) || isNaN(b)) {
        return 0; 
    }
    return a / b; 
}

function cleanFloat(num, decimals = 6) {
    const n = Number(num);
    if (!Number.isFinite(n)) return '0';
    const out = parseFloat(n.toFixed(decimals)).toString();
    return out === '-0' ? '0' : out;
}

function formatNum(num) { 
    const n = Number(num);
    if (!Number.isFinite(n)) return '0.00';
    if (Math.abs(n) >= 1e9) return cleanFloat(n / 1e9, 2) + 'B'; 
    if (Math.abs(n) >= 1e6) return cleanFloat(n / 1e6, 2) + 'M'; 
    if (Math.abs(n) >= 1e3) return cleanFloat(n / 1e3, 2) + 'K'; 
    return n.toFixed(2); 
}


function getPriceDecimalsFromMeta() {
    const meta = window.AppState && AppState.marketMeta ? AppState.marketMeta : null;
    if (meta && Number.isFinite(meta.pricePrecision)) return Math.max(0, Math.min(10, meta.pricePrecision));
    if (meta && Number.isFinite(meta.tickSize) && meta.tickSize > 0) {
        const raw = Math.round(Math.log10(1 / meta.tickSize));
        return Math.max(0, Math.min(10, raw));
    }
    return null;
}

// FUNGSI PINTAR UNTUK FORMAT HARGA KOIN MICIN PEPE / SHIB (Mencegah Blank Chart)
function formatPrice(p) {
    const num = Number(p);
    if (!Number.isFinite(num)) return '0';

    const abs = Math.abs(num);
    let decimals = getPriceDecimalsFromMeta();
    if (!Number.isFinite(decimals)) decimals = null;
    if (decimals === null) {
        if (abs >= 1000) decimals = 2;
        else if (abs >= 1) decimals = 4;
        else if (abs >= 0.0001) decimals = 6;
        else decimals = 8;
    }

    let out = num.toFixed(decimals);
    out = out.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
    if (out === '-0') out = '0';
    return out;
}

function formatPriceInput(p) {
    return formatPrice(p);
}

function formatFullDate(ms) { 
    // Ledger/market data bisa datang dari localStorage yang dimanipulasi atau
    // riwayat server lama: nilai non-finite di sini dulu melempar
    // RangeError("Invalid time value") dan meruntuhkan seluruh render ledger.
    const time = Number(ms);
    if (!Number.isFinite(time) || time <= 0 || time > 8.64e15) return '-';
    return new Intl.DateTimeFormat('id-ID', { month: 'short', day:'2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(time)); 
}

window.handlePctChange = function(type) { 
    const sel = document.getElementById(type + '-pct-sel');
    const cust = document.getElementById(type + '-pct-custom'); 
    if (sel.value === 'custom') { 
        sel.style.display = 'none'; 
        cust.style.display = 'block'; 
        cust.focus(); 
    } else { 
        cust.style.display = 'none'; 
        cust.value = ''; 
    } 
};
window.cleanFloat = cleanFloat;
window.formatPrice = formatPrice;
window.formatPriceInput = formatPriceInput;

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { safeDiv, cleanFloat, formatNum, formatPrice, formatPriceInput };
}
