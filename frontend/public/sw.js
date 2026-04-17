/* global clients */
// Service worker for PWA install support and push notifications.
// Only intercept navigation requests (page loads). Let API calls, analytics,
// and other subresource fetches go straight to the network without SW interference.
self.addEventListener('fetch', function (event) {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(
    fetch(event.request).catch(function () {
      return new Response('Offline', {
        status: 503,
        statusText: 'Service Unavailable',
      });
    })
  );
});

// Push notification handler
self.addEventListener('push', function (event) {
  var data = {};
  try {
    data = event.data.json();
  } catch {
    /* ignore parse errors */
  }
  event.waitUntil(
    self.registration.showNotification(data.displayName || 'Relay IDE', {
      body: 'Session needs your input',
      tag: 'session-' + (data.sessionId || ''),
      data: { sessionId: data.sessionId, sessionType: data.sessionType },
    })
  );
});

// Notification click handler — focus existing tab or open new one
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var notifData = event.notification.data || {};
  var sessionId = notifData.sessionId;
  var sessionType = notifData.sessionType;
  if (!sessionId) return;
  var tabMap = { repo: 'repos', worktree: 'worktrees' };
  var tab = tabMap[sessionType] || 'repos';
  var url = '/?session=' + sessionId + '&tab=' + tab;

  event.waitUntil(
    clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then(function (clientList) {
        for (var i = 0; i < clientList.length; i++) {
          var client = clientList[i];
          if (client.url.indexOf(self.location.origin) !== -1) {
            client.postMessage({
              type: 'notification-click',
              sessionId: sessionId,
              sessionType: sessionType,
            });
            return client.focus();
          }
        }
        return clients.openWindow(url);
      })
  );
});
