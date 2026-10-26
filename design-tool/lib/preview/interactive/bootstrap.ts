// The interactive preview's bootstrap (editor redesign Phase 5 slice B,
// ADR 0019 §4–§5): the one script of our own that runs inside the preview
// frame, beside KaTeX and the student's renderer. Its text is FIXED — it
// carries no item content — so the shell route pins it by hash like the
// other two.
//
// What it does, in order:
//   1. Defines `window.webkit.messageHandlers` as a stub. Each handler
//      forwards `{kind: "bridge", handler, body}` on the port; a drawing's
//      bytes are dropped here and never leave the frame.
//   2. Opens a MessageChannel and posts ONE `ready` message, with one port,
//      to `window.parent`. Everything after that travels on the port.
//   3. On the parent's `load` message — data only, never evaluated — assigns
//      the page globals the renderer reads (BUNDLE, OFFLINE, TTS_SCOPE,
//      STT_STATE, KATEX_MACROS; AssessmentPage.html() in the client), then
//      inserts the renderer, whose text sits in the shell as an inert
//      `<script type="text/plain">`, as an inline script. The CSP admits it
//      only if its text hashes to the pinned value.
//   4. Tags each rendered question block with its position so a click can
//      name the question (`jump`) and the parent can scroll to one
//      (`scroll_to`). When the blocks do not line up one-to-one with the
//      bundle's items, linking is reported off rather than guessed.
//   5. Relays read-aloud callbacks from the parent (`speech`) into the
//      renderer's `window.__secureTestSpeech`, the hooks the macOS host calls.
//
// Plain ES5 for the same reason as the renderer: no modules, no network, no
// eval, and never the sequence `</` (it is inlined into a script element).

/** `type` of the one window-level message (frame → parent). */
export const PREVIEW_PROTOCOL = "secure-test-preview";
export const PREVIEW_PROTOCOL_VERSION = 1;

/** Ids of the shell elements the bootstrap reads. */
export const RENDERER_SOURCE_ID = "renderer-source";

/** Largest bridge body (JSON characters) the bootstrap forwards. */
export const MAX_BRIDGE_BODY_CHARS = 262_144;

export const PREVIEW_BOOTSTRAP_JS = `(function () {
  'use strict';
  var PROTOCOL = '${PREVIEW_PROTOCOL}';
  var VERSION = ${PREVIEW_PROTOCOL_VERSION};
  var MAX_BODY = ${MAX_BRIDGE_BODY_CHARS};
  var HANDLERS = ['response', 'withdraw', 'upload', 'submit', 'timer', 'home', 'tts', 'stt'];
  var SPEECH_EVENTS = { started: true, paused: true, resumed: true, word: true, finished: true, cancelled: true };
  var channel = new MessageChannel();
  var port = channel.port1;
  var loaded = false;
  var linked = false;
  var itemIds = [];

  function send(message) {
    try { port.postMessage(message); } catch (e) {}
  }

  // A body leaves the frame as plain JSON data, size-capped, or not at all.
  function plain(body) {
    try {
      var text = JSON.stringify(body);
      if (typeof text !== 'string' || text.length > MAX_BODY) return null;
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  var handlers = {};
  HANDLERS.forEach(function (name) {
    handlers[name] = {
      postMessage: function (body) {
        send({ kind: 'bridge', handler: name, body: name === 'upload' ? null : plain(body) });
      }
    };
  });
  try {
    Object.defineProperty(window, 'webkit', { value: { messageHandlers: handlers }, writable: false });
  } catch (e) {
    window.webkit = { messageHandlers: handlers };
  }

  window.addEventListener('error', function (event) {
    send({ kind: 'error', message: String((event && event.message) || 'error').slice(0, 300) });
  });

  function tag(bundle) {
    var blocks = document.querySelectorAll('#items .item');
    var ids = [];
    for (var i = 0; i < bundle.items.length; i++) {
      var item = bundle.items[i];
      ids.push(item && typeof item.id === 'string' ? item.id : '');
    }
    if (blocks.length !== ids.length) return;
    for (var j = 0; j < blocks.length; j++) blocks[j].setAttribute('data-preview-item', String(j));
    itemIds = ids;
    linked = true;
  }

  function start(payload) {
    if (loaded || !payload || typeof payload !== 'object') return;
    var bundle = payload.bundle;
    if (!bundle || typeof bundle !== 'object' || !Array.isArray(bundle.items)) return;
    loaded = true;
    var scope = payload.tts_scope;
    var macros = payload.katex_macros;
    window.BUNDLE = bundle;
    window.OFFLINE = payload.offline === true;
    window.TTS_SCOPE = scope && typeof scope === 'object'
      ? { items: scope.items === true, stimuli: scope.stimuli === true, responses: scope.responses === true }
      : { items: false, stimuli: false, responses: false };
    window.STT_STATE = 'off';
    window.KATEX_MACROS = macros && typeof macros === 'object' ? macros : {};
    var title = typeof bundle.title === 'string' ? bundle.title : '';
    document.title = title;
    var heading = document.querySelector('h1');
    if (heading) heading.textContent = title;
    var source = document.getElementById('${RENDERER_SOURCE_ID}');
    var script = document.createElement('script');
    script.textContent = source ? source.textContent : '';
    document.body.appendChild(script);
    tag(bundle);
    send({ kind: 'rendered', linked: linked, items: itemIds.length });
  }

  function scrollToItem(id, smooth) {
    if (!linked) return;
    var at = itemIds.indexOf(id);
    if (at < 0) return;
    var block = document.querySelector('[data-preview-item="' + at + '"]');
    if (block && typeof block.scrollIntoView === 'function') {
      block.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'auto' });
    }
  }

  function isCount(value) {
    return typeof value === 'number' && value >= 0 && value % 1 === 0;
  }

  function speech(message) {
    var api = window.__secureTestSpeech;
    if (!api || typeof message.event !== 'string' || SPEECH_EVENTS[message.event] !== true) return;
    if (typeof message.id !== 'string') return;
    var fn = api[message.event];
    if (typeof fn !== 'function') return;
    if (message.event === 'word') {
      if (!isCount(message.segment) || !isCount(message.offset) || !isCount(message.length)) return;
      fn(message.id, message.segment, message.offset, message.length);
    } else {
      fn(message.id);
    }
  }

  document.addEventListener('click', function (event) {
    if (!linked) return;
    var el = event.target;
    while (el && el.nodeType === 1) {
      var at = el.getAttribute('data-preview-item');
      if (at !== null) {
        var id = itemIds[Number(at)];
        if (id) send({ kind: 'jump', item_id: id });
        return;
      }
      el = el.parentNode;
    }
  }, true);

  port.onmessage = function (event) {
    var message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.kind === 'load') start(message.payload);
    else if (message.kind === 'scroll_to' && typeof message.item_id === 'string') {
      scrollToItem(message.item_id, message.smooth === true);
    } else if (message.kind === 'speech') speech(message);
  };

  // frame-ancestors 'self' is what makes '*' safe here: only the design
  // tool's own pages can be this frame's parent, and an opaque-origin frame
  // cannot name that origin itself (no referrer, no ancestorOrigins in every
  // browser).
  window.parent.postMessage({ type: PROTOCOL, kind: 'ready', version: VERSION }, '*', [channel.port2]);
})();
`;
