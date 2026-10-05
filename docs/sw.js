// 설치 가능 조건용 최소 서비스워커. 캐시는 하지 않고 항상 네트워크로 간다(주문 화면은 항상 최신이어야 함).
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function () { /* 기본 동작 */ });
