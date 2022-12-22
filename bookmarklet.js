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
  const yamanote = 'http://localhost:3456'; /* Will be over-written! */

  const t = window.open(yamanote + '/popup', 'Yamanote', 'toolbar=no,width=200,height=200');
  interval = setInterval(() => {
    t.postMessage(JSON.stringify(obj), yamanote);
    console.log('posted…')
  }, 200);

  /* this might be running in a locked own Cross-Origin-Opener-Policy so `postMessage` might never reach the popup */
  const noPostMessage = setTimeout(() => {
    clearInterval(interval);
    if (!window.__yamanote) {
      /* We've not yet POSTed the DOM */
      const bodyHtml = document.body.innerHTML;
      const headHtml = document.head.innerHTML;
      obj['html'] = `<head>${headHtml}</head>${bodyHtml}`;
    }
    const req = fetch(yamanote + '/bookmark', {
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify(obj),
      headers: {'Content-Type': 'application/json'}
    });
    t.close();
  }, 2000);

  if (window.__yamanote) { return; }
  window.__yamanote = true;
  window.addEventListener('message', (event) => {
    if (event.origin === yamanote) {
      clearTimeout(noPostMessage);
      clearInterval(interval);
      console.log('event received from Yamanote');
      const recv = JSON.parse(event.data);
      if (recv.id && recv.htmlWanted) {
        const bodyHtml = document.body.innerHTML;
        const headHtml = document.head.innerHTML;
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
