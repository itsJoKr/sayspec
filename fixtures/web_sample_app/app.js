const products = [
  { id: 'coffee', name: 'Coffee beans', detail: 'A bright, balanced morning cup.', origin: 'Colombia · 250 g', priceCents: 1200, symbol: '☼', color: 'coffee' },
  { id: 'tea', name: 'Green tea', detail: 'Soft, grassy notes for a slower afternoon.', origin: 'Uji, Japan · 50 g', priceCents: 800, symbol: '〰', color: 'tea' },
];

const cart = new Map();
const app = document.querySelector('#app');
const cartButton = document.querySelector('[data-testid="cart-button"]');
const cartCount = document.querySelector('[data-testid="cart-count"]');
let page = 'catalog';
let lastOrder = [];

const money = (cents) => `$${(cents / 100).toFixed(2)}`;
const cartItems = () => [...cart.entries()].map(([id, quantity]) => ({ ...products.find((product) => product.id === id), quantity }));
const itemCount = () => [...cart.values()].reduce((sum, quantity) => sum + quantity, 0);
const baseSubtotal = () => cartItems().reduce((sum, item) => sum + item.priceCents * item.quantity, 0);
const sampleBugEnabled = new URLSearchParams(location.search).get('bug') === 'cart-total';

function displaySubtotal() {
  const correctSubtotal = baseSubtotal();
  // Intentional fixture defect: a non-empty cart loses an extra $5.00.
  return sampleBugEnabled && correctSubtotal > 0 ? correctSubtotal - 500 : correctSubtotal;
}

function updateCartBadge() {
  const count = itemCount();
  cartCount.textContent = String(count);
  cartButton.setAttribute('aria-label', `Open cart, ${count} ${count === 1 ? 'item' : 'items'}`);
}

function renderCatalog() {
  page = 'catalog';
  app.innerHTML = `
    <section class="hero" aria-labelledby="page-title">
      <div class="hero-copy">
        <p class="eyebrow"><span class="eyebrow-dot"></span> THE EVERYDAY EDIT · NO. 04</p>
        <h1 id="page-title">A little more<br /><em>thoughtful.</em></h1>
        <p class="hero-description">Useful things for unhurried mornings and the moments in between.</p>
        <a class="text-link" href="#catalog">Meet your new favourites <span aria-hidden="true">↓</span></a>
      </div>
      <div class="hero-art" aria-label="Coffee and tea, ready for a quiet morning" role="img">
        <div class="sun-disc"></div><div class="cup-shadow"></div><div class="cup"><div class="cup-coffee"></div></div><div class="cup-handle"></div>
        <span class="art-caption">Make room<br />for a pause.</span>
        <span class="art-stamp">SLOW<br />MORNINGS<br />CLUB</span>
      </div>
    </section>

    <section id="catalog" class="catalog-section" aria-labelledby="catalog-title">
      <div class="section-heading"><div><p class="eyebrow">GOOD TO HAVE AROUND</p><h2 id="catalog-title">The small essentials</h2></div><p class="section-aside">Thoughtfully chosen.<br />A pleasure to use.</p></div>
      <div class="product-grid">
        ${products.map((product, index) => `
          <article class="product-card" data-testid="product-${product.id}">
            <div class="product-art product-art--${product.color}">
              <span class="product-number">0${index + 1} / EVERYDAY</span>
              <span class="product-symbol" aria-hidden="true">${product.symbol}</span>
              <span class="product-art-label">${product.id === 'coffee' ? 'DAILY<br />RITUAL' : 'TAKE IT<br />SLOW'}</span>
            </div>
            <div class="product-details">
              <div><p class="product-origin">${product.origin}</p><h3>${product.name}</h3><p class="product-description">${product.detail}</p></div>
              <p class="product-price">${money(product.priceCents)}</p>
            </div>
            <button class="add-button" type="button" data-testid="add-to-cart-${product.id}" data-add="${product.id}"><span>Add to basket</span><span aria-hidden="true">+</span></button>
          </article>`).join('')}
      </div>
    </section>
    <section class="note-strip"><span class="note-icon" aria-hidden="true">✳</span><p>Little-batch favourites, picked for the everyday.</p><span>EST. FOR SLOW LIVING</span></section>
  `;

  app.querySelectorAll('[data-add]').forEach((button) => button.addEventListener('click', () => {
    const id = button.dataset.add;
    cart.set(id, (cart.get(id) || 0) + 1);
    updateCartBadge();
    button.classList.add('added');
    button.querySelector('span').textContent = 'Added';
    window.setTimeout(() => { if (button.isConnected) { button.classList.remove('added'); button.querySelector('span').textContent = 'Add to basket'; } }, 850);
  }));
}

function renderCart() {
  page = 'cart';
  const items = cartItems();
  app.innerHTML = `
    <section class="subpage" aria-labelledby="page-title">
      <a class="back-link" href="#catalog" data-action="catalog"><span aria-hidden="true">←</span> Continue browsing</a>
      <div class="subpage-heading"><p class="eyebrow">YOUR LITTLE COLLECTION</p><h1 id="page-title">Your basket<span class="heading-period">.</span></h1><p>${itemCount()} ${itemCount() === 1 ? 'good thing' : 'good things'} to brighten the day.</p></div>
      ${items.length ? `
        <div class="cart-layout">
          <div class="cart-items" aria-label="Basket items">
            ${items.map((item) => `
              <article class="cart-item" data-testid="cart-item-${item.id}">
                <div class="cart-item-art cart-item-art--${item.color}" aria-hidden="true">${item.symbol}</div>
                <div class="cart-item-copy"><p class="product-origin">${item.origin}</p><h2>${item.name}</h2><p>${money(item.priceCents)} each</p><button class="remove-link" type="button" data-remove="${item.id}">Remove</button></div>
                <div class="quantity-controls" aria-label="${item.name} quantity"><button type="button" data-quantity="${item.id}" data-delta="-1" aria-label="Remove one ${item.name}">−</button><span>${item.quantity}</span><button type="button" data-quantity="${item.id}" data-delta="1" aria-label="Add one ${item.name}">+</button></div>
                <p class="line-price">${money(item.priceCents * item.quantity)}</p>
              </article>`).join('')}
          </div>
          <aside class="order-summary" aria-label="Order summary">
            <p class="eyebrow">THE LITTLE DETAILS</p><h2>Order summary</h2>
            <div class="summary-row"><span>Subtotal</span><span data-testid="cart-subtotal">${money(displaySubtotal())}</span></div>
            <div class="summary-row"><span>Delivery</span><span class="free-delivery">On us</span></div>
            <div class="summary-total"><span>Total</span><strong data-testid="cart-total">${money(displaySubtotal())}</strong></div>
            <button class="checkout-button" type="button" data-testid="checkout-button">Place your order <span aria-hidden="true">→</span></button>
            <p class="secure-note"><span aria-hidden="true">✳</span> A good choice, coming right up.</p>
          </aside>
        </div>` : `
        <div class="empty-cart"><span aria-hidden="true">◌</span><h2>Nothing in your basket yet.</h2><p>There are lovely things waiting back at the shop.</p><button class="checkout-button" type="button" data-action="catalog">Explore the collection <span aria-hidden="true">→</span></button></div>`}
    </section>
  `;

  app.querySelector('[data-action="catalog"]')?.addEventListener('click', (event) => { event.preventDefault(); renderCatalog(); });
  app.querySelectorAll('[data-remove]').forEach((button) => button.addEventListener('click', () => { cart.delete(button.dataset.remove); updateCartBadge(); renderCart(); }));
  app.querySelectorAll('[data-quantity]').forEach((button) => button.addEventListener('click', () => {
    const id = button.dataset.quantity;
    const next = (cart.get(id) || 0) + Number(button.dataset.delta);
    if (next < 1) cart.delete(id); else cart.set(id, next);
    updateCartBadge(); renderCart();
  }));
  app.querySelector('[data-testid="checkout-button"]')?.addEventListener('click', renderReceipt);
}

function renderReceipt() {
  page = 'receipt';
  lastOrder = cartItems();
  const total = displaySubtotal();
  cart.clear();
  updateCartBadge();
  app.innerHTML = `
    <section class="receipt" aria-labelledby="page-title">
      <div class="receipt-spark" aria-hidden="true">✳</div>
      <p class="eyebrow">A MOMENT WELL SPENT</p>
      <h1 id="page-title" data-testid="order-confirmed">Order confirmed<span class="heading-period">.</span></h1>
      <p class="receipt-description">Your good things are being gathered with care.</p>
      <div class="receipt-card"><p>YOUR ORDER</p>${lastOrder.map((item) => `<div><span>${item.name} × ${item.quantity}</span><span>${money(item.priceCents * item.quantity)}</span></div>`).join('')}<div class="receipt-total"><strong>Total paid</strong><strong data-testid="receipt-total">${money(total)}</strong></div></div>
      <button class="checkout-button" type="button" data-action="catalog">Back to the collection <span aria-hidden="true">→</span></button>
      <p class="receipt-reference">Order FN-${String(Date.now()).slice(-6)}</p>
    </section>
  `;
  app.querySelector('[data-action="catalog"]').addEventListener('click', renderCatalog);
}

cartButton.addEventListener('click', renderCart);
renderCatalog();
