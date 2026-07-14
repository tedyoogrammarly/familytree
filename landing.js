// Quote form -> email. When someone submits the form, this composes an email
// to Ted with their details and opens their email app to send it. No server
// needed. Externalized (not inline) to stay CSP-friendly, matching config.js.
(function () {
  var RECIPIENT = 'yoo.ted@outlook.com'; // where quote requests are sent
  var form = document.getElementById('quote-form');
  var note = document.getElementById('form-note');
  if (!form) return;
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var val = function (id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; };
    var name = val('name'), business = val('business'), contact = val('contact-info'), message = val('message');
    if (!name || !contact) {
      note.textContent = 'Please add your name and an email or phone so I can reach you.';
      note.className = 'form-note is-error';
      return;
    }
    var subject = 'Website quote request from ' + name + (business ? ' (' + business + ')' : '');
    var body = [
      'Name: ' + name,
      'Business: ' + (business || '(not given)'),
      'Best way to reach me: ' + contact,
      '',
      'What I am looking for:',
      message || '(no details added)'
    ].join('\n');
    var mailtoUrl = 'mailto:' + RECIPIENT +
      '?subject=' + encodeURIComponent(subject) +
      '&body=' + encodeURIComponent(body);
    // Trigger the visitor's email app via a real anchor click (more reliable
    // than assigning location.href across browsers).
    var a = document.createElement('a');
    a.href = mailtoUrl;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Always leave a clickable fallback in case no email app opens on its own.
    note.innerHTML = 'Your email app should open with the request ready to send. ' +
      'If nothing opens, <a href="' + mailtoUrl + '">click here to email me</a>.';
    note.className = 'form-note is-ok';
  });
})();
