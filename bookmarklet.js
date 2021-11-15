q = location.href;
p = document.title;
s = window.getSelection().toString();
obj = {
  url: document.location.href || '',
  title: document.title || '',
  comment: s,
};
fetch('http://localhost:3456/bookmark',
      {method: 'POST', mode: 'cors', body: JSON.stringify(obj), headers: {'Content-Type': 'application/json'}})