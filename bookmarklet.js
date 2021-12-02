javascript: (function() {
  const q = location.href;
  const p = document.title;
  const s = window.getSelection().toString();
  const obj = {
    _type: 'addBookmarkOrComment',
    url: document.location.href || '',
    title: document.title || '',
    comment: s,
    quote: true,
    rand: Math.random(),
  };
  const yamanote = 'http://localhost:3456';

  const t = window.open(yamanote + '/popup', 'Yamanote', 'toolbar=no,width=200,height=200');
  interval = setInterval(() => {
    t.postMessage(JSON.stringify(obj), yamanote);
    console.log('posted…')
  }, 200);

  if (window.__yamanote) {
    return;
  }
  window.__yamanote = true;
  window.addEventListener('message', (event) => {
    if (event.origin === yamanote) {
      clearInterval(interval);
      console.log('event received from Yamanote');
      const recv = JSON.parse(event.data);
      if (recv.id && recv.htmlWanted) {
        bodyHtml = document.body.innerHTML;
        headHtml = document.head.innerHTML;
        const obj = {
          _type: 'addHtml',
          id: recv.id,
          html: `<head>${headHtml}</head>${bodyHtml}`,
        };
        t.postMessage(JSON.stringify(obj), yamanote);
      }
    } else {
      console.log('unprocessed event received from ' + event.origin);
    }
  });
})()
