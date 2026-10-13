// PLACEHOLDER renderer. Slice 5 (docs/server-delivered-renderer-design.md)
// replaces this file with the real student page code, moved in byte for
// byte from the client, so the first served renderer equals the last
// bundled one. Until then it exists only so the build, the manifest, the
// signature and the route have a real file to carry.
//
// Rules for this file, real or placeholder: plain browser JavaScript, no
// imports, no network, no eval, and never the two characters less-than
// followed by slash anywhere (the client inlines it into a script element).
(function () {
  "use strict";

  var bridge =
    window.webkit && window.webkit.messageHandlers
      ? window.webkit.messageHandlers
      : null;

  function post(name, body) {
    if (bridge && bridge[name]) {
      bridge[name].postMessage(body);
    }
  }

  function render(bundle) {
    var root = document.getElementById("app") || document.body;
    var title = document.createElement("h1");
    title.textContent = (bundle && bundle.title) || "Test";
    root.appendChild(title);

    var note = document.createElement("p");
    note.textContent = "Placeholder renderer.";
    root.appendChild(note);

    var done = document.createElement("button");
    done.type = "button";
    done.textContent = "Hand in";
    done.addEventListener("click", function () {
      post("submit", {});
    });
    root.appendChild(done);
  }

  window.secureTestRenderer = {
    render: render,
    response: function (itemId, type, value) {
      post("response", { item_id: itemId, type: type, value: value });
    },
    home: function () {
      post("home", {});
    },
  };
})();
