import './styles.css';

// Every app call to action goes through /get-app, which owns desktop download
// availability. No build-time download URL may rewrite these links directly.
document.querySelectorAll<HTMLAnchorElement>('[data-get-app-link]').forEach((link) => {
  link.href = '/get-app';
});

// The hero demo autoplays muted (browsers require it); the button turns the narration on.
// With reduced motion requested it stays paused on its poster and shows native controls.
const demo = document.querySelector<HTMLVideoElement>('[data-demo-video]');
const sound = document.querySelector<HTMLButtonElement>('[data-demo-sound]');
if (demo) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    demo.removeAttribute('autoplay');
    demo.pause();
    demo.controls = true;
    sound?.remove();
  } else if (sound) {
    const label = sound.querySelector('span');
    sound.addEventListener('click', () => {
      demo.muted = !demo.muted;
      if (!demo.muted) {
        demo.currentTime = 0;
        void demo.play();
      }
      sound.setAttribute('aria-pressed', String(!demo.muted));
      if (label) label.textContent = demo.muted ? 'Sound on' : 'Mute';
    });
  }
}
