window.addEventListener("message", async (event) => {
  // console.log('eventor!',event);
  document.body.append('going to await');
  let origin = '*';
  try {
    const obj = JSON.parse(event.data);
    const url = new URL(obj.url);
    origin = url.origin;
  } catch {}
  const res = await fetch(
      '/bookmark', {method: 'POST', mode: 'cors', body: event.data, headers: {'Content-Type': 'application/json'}});
  if (res.ok) {
    const reply = await res.json();
    if (reply && reply.htmlWanted) {
      // can we avoid this round-trip JSON decode-encode?
      event.source.postMessage(JSON.stringify(reply), origin);
      document.body.append('… asking for HTML');
    } else {
      document.body.append('… OK!');
      window.close();
    }
  } else {
    document.body.append('… uhoh');
    const err = `${res.status} ${res.statusText}`;
    console.error(err);
    alert(err);
  }
}, false);

window.onload = () => {
  const a = document.querySelector('a#bookmarklet');
  if (a && a.href) {
    a.href = a.href.replace(/http:\/\/localhost:3456/g, window.location.origin);
  }

  for (const a of document.querySelectorAll('a.add-comment-button')) {
    a.addEventListener('click', e => {
      e.preventDefault();
      /**
       * @type{Element}
       */
      const target = e.target;
      /**
       * @type{string}
       */
      const clickId = target.id;
      const id = parseInt(clickId.slice(clickId.lastIndexOf('-') + 1));
      if (isFinite(id)) {
        const textarea = document.createElement('textarea');
        textarea.id = 'new-comment';
        const button = document.createElement('button');
        button.innerText = 'Submit';
        const div = document.createElement('div');
        div.appendChild(textarea);
        div.appendChild(button);
        target.replaceWith(div); // replace the emoji <a> with this

        button.onclick = () => {
          const obj = {id, comment: textarea.value};
          console.log('WILL POST', obj);
          fetch('/bookmark', {method: 'POST', body: JSON.stringify(obj), headers: {'Content-Type': 'application/json'}})
              .then(x => {
                if (x.ok) {
                  location.reload();
                } else {
                  const err = `${x.status} ${x.statusText}`;
                  console.error(err);
                }
              });
        };
      }
    });
  }
};
