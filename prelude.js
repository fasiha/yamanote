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

  // These special classes are implemented in renderers.ts, e.g.,
  // `add-comment-button` and `comment-button`, etc.

  /**
   *
   * @param {Event} e
   */
  function handler(e) {
    e.preventDefault();
    /**
     * @type{Element}
     */
    const target = e.target;
    const clickId = target.id;
    const id = parseInt(clickId.slice(clickId.lastIndexOf('-') + 1));
    if (isFinite(id)) {
      if (target.classList.contains('add-comment-button')) {
        const textarea = document.createElement('textarea');
        const button = document.createElement('button');
        button.innerText = 'Submit';
        const div = document.createElement('div');
        div.appendChild(textarea);
        div.appendChild(button);
        target.replaceWith(div); // replace the emoji <a> with this

        button.onclick = () => {
          const obj = {id, comment: textarea.value, _type: 'addCommentOnly'};
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
      } else if (target.classList.contains('edit-comment-button')) {
        const comment = target.parentElement.querySelector('pre.unrendered')?.textContent;
        if (typeof comment !== 'string') {
          return;
        }

        const textarea = document.createElement('textarea');
        textarea.value = comment;
        const button = document.createElement('button');
        button.innerText = 'Submit';
        const div = document.createElement('div');
        div.appendChild(textarea);
        div.appendChild(button);
        target.parentElement.replaceWith(div); // replace the entire comment with this <div>

        button.onclick = () => {
          const obj = {content: textarea.value};
          fetch('/comment/' + id,
                {method: 'PUT', body: JSON.stringify(obj), headers: {'Content-Type': 'application/json'}})
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
    }
  };
  for (const a of document.querySelectorAll('a.comment-button')) { a.addEventListener('click', handler); }
};
