# SaySpec Web sample app

Fieldnote Market is a small local storefront for trying SaySpec's Web recording,
Playwright run, failure explanation, and approved-fix flows. It uses only Node.js
built-ins and browser APIs; no account, network service, or customer data is
needed.

## Run it

From this folder:

```sh
npm run dev
```

The storefront listens at <http://127.0.0.1:4173/>. Set `PORT` to choose another
local port. Create a Web project in SaySpec with the base URL
`http://127.0.0.1:4173/?bug=cart-total` and this folder as its optional source
code folder. The source folder lets SaySpec prepare a reviewed fix proposal.

## Known sample defect: cart total is $5 low

The defect is enabled only with the `bug=cart-total` URL parameter. Add Coffee
beans ($12.00), open the cart, and the subtotal and total will incorrectly show
$7.00. Placing the order carries the same incorrect amount to the receipt. The
fault is isolated to `displaySubtotal()` in `app.js`; remove the $5 deduction to
make the expected result $12.00. Open the base URL without the query parameter
to run the storefront without the injected defect.

The stable selectors for the repro are `add-to-cart-coffee`, `cart-button`,
`cart-total`, `checkout-button`, and `receipt-total`. Useful narration:
“Add the coffee beans and check the basket total; it should be twelve dollars.”

## Sample flow

1. Add Coffee beans or Green tea from the catalog.
2. Open Cart and review the item, subtotal and delivery.
3. Place the order and check the confirmation receipt.

The app uses semantic headings and buttons, accessible labels, responsive
layout, deterministic prices and no persistent storage, so each page reload
starts with an empty basket.
