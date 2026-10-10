import './styles.css';

// Every app call to action goes through /get-app, which owns desktop download
// availability. No build-time download URL may rewrite these links directly.
document.querySelectorAll<HTMLAnchorElement>('[data-get-app-link]').forEach((link) => {
  link.href = '/get-app';
});
