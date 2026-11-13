(function () {
  var html = document.documentElement;
  html.classList.add('m-enter');
  setTimeout(function () { html.classList.add('m-enter-done'); }, 700);
  if (document.currentScript && document.currentScript.hasAttribute('data-moments')) {
    html.classList.add('mo-js');
    setTimeout(function () { html.classList.add('mo-safe'); }, 2500);
  }
})();
