window.addEventListener("message", async (event) => {
  // console.log('eventor!',event);
  document.body.append('going to await');
  const res =
      await fetch(window.location.origin + '/bookmark',
                  {method: 'POST', mode: 'cors', body: event.data, headers: {'Content-Type': 'application/json'}});
  if (res.ok) {
    document.body.append('… OK!');
    window.close();
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
};
