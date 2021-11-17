javascript: (function() {
  q = location.href;
  p = document.title;
  s = window.getSelection().toString();
  obj = {
    url: document.location.href || '',
    title: document.title || '',
    comment: s,
  };
  t = window.open('http://localhost:3456/popup', 'Yamanote', 'toolbar=no,width=100,height=100');
  setTimeout(() => { t.postMessage(JSON.stringify(obj), 'http://localhost:3456'); }, 500);
})()
