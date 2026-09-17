importScripts("https://www.gstatic.com/firebasejs/12.1.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/12.1.0/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyBBAwpBIO4SE-GlfmPdyuTZwnX3R2jvcj8",
  authDomain: "my-planner-f4aa2.firebaseapp.com",
  projectId: "my-planner-f4aa2",
  storageBucket: "my-planner-f4aa2.firebasestorage.app",
  messagingSenderId: "272413881684",
  appId: "1:272413881684:web:6923f366bfaecc3a7204c1"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  self.registration.showNotification(
    payload.notification?.title || "My Planner",
    {
      body: payload.notification?.body || "มีการแจ้งเตือนใหม่"
    }
  );
});
