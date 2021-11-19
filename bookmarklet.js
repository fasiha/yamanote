javascript: (function() {
  q = location.href;
  p = document.title;
  s = window.getSelection().toString();
  obj = {
    _type: 'addBookmarkOrComment',
    url: document.location.href || '',
    title: document.title || '',
    comment: s,
    quote: true,
  };
  const yamanote = 'http://localhost:3456';

  t = window.open(yamanote + '/popup', 'Yamanote', 'toolbar=no,width=100,height=100');
  setTimeout(() => { t.postMessage(JSON.stringify(obj), yamanote); }, 500);
  if (window.__yamanote) {
    return;
  }
  window.__yamanote = true;
  window.addEventListener('message', (event) => {
    console.log('I RECEIVED AN EVENT!');
    if (event.origin === yamanote) {
      console.log('ITS FROM YAMANOTE!!!');
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
    }
  });
})()
