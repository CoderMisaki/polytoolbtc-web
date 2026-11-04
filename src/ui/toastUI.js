let toastTimeout;

function toggleToast(show, msg, isError = false) { 
    const t = document.getElementById('sys-toast'); 
    if (!t) return; 
    // textContent, never innerHTML: toast strings carry server error texts and
    // exchange-fed labels (e.g. "sinkronisasi akun gagal: <body.error>"), and a
    // hostile or compromised upstream must not turn the toast into an HTML sink.
    if (msg !== undefined && msg !== null) t.textContent = String(msg);
    t.classList.toggle('toast-error', !!isError);
    t.classList.toggle('toast-normal', !isError);
    t.classList.toggle('toast-visible', !!show); 
}

function showToast(msg, isError = false, duration = null) {
    if (toastTimeout) clearTimeout(toastTimeout); 
    toggleToast(true, msg, isError); 

    let time = duration;
    if (!time) {
        time = isError ? 5000 : 3000;
    }

    toastTimeout = setTimeout(() => { toggleToast(false); }, time);
}
