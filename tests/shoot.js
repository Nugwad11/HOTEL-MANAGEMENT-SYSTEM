#!/usr/bin/env node
/* Drives a local Chrome over the DevTools Protocol with no npm dependencies and
   writes PNGs of the demo, because the in-app browser view cannot be captured. */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CHROME = process.env.HMS_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number(process.env.HMS_CDP_PORT || 9333);
const BASE = process.env.HMS_BASE || 'http://127.0.0.1:4173/index.html';
const OUT = process.env.HMS_SHOTS || path.resolve(__dirname, 'shots');
const PROFILE = path.join(process.env.LOCALAPPDATA || OUT, 'hms-shoot-profile');
const DESKTOP = [1440, 900];
const PHONE = [430, 932];

/* Each step runs its expressions in the page, waits, then captures a PNG. */
const STEPS = [
  { name: '01-login', vp: PHONE },
  {
    name: '02-guest-stay', vp: PHONE, wait: 900,
    do: [`document.querySelector('[data-act="guest-signin"]').click()`]
  },
  {
    name: '03-guest-requests', vp: PHONE, wait: 500,
    do: [`LHMS.go('guest/requests')`, `LHMS.rerender()`]
  },
  {
    name: '04-guest-folio', vp: PHONE, wait: 500,
    do: [`LHMS.go('guest/folio')`, `LHMS.rerender()`]
  },
  {
    name: '05-guest-profile', vp: PHONE, wait: 500,
    do: [`LHMS.go('guest/me')`, `LHMS.rerender()`]
  },
  {
    name: '06-book-modal', vp: PHONE, wait: 700,
    do: [
      `LHMS.go('guest/stay')`, `LHMS.rerender()`,
      `LHMS.uiActions['guest-book']()`,
      `(function () { var f = document.querySelector('#modal-root [data-form="guest-book"]'); var U = LHMS.util;
        var set = function (n, v) { var e = f.querySelector('[name="' + n + '"]'); e.value = v; e.dispatchEvent(new Event('change', { bubbles: true })); };
        set('propertyId', 'apa'); set('roomTypeId', 'dk');
        set('checkIn', U.addDays(U.today(), 30)); set('checkOut', U.addDays(U.today(), 33));
        set('adults', '2'); set('children', '0'); })()`
    ]
  },
  {
    name: '06b-book-modal-bottom', vp: PHONE, wait: 400,
    do: [`document.querySelector('#modal-root .modal').scrollTo(0, 9999)`]
  },
  {
    name: '07-book-occupancy-error', vp: PHONE, wait: 500,
    do: [
      `(function () { var f = document.querySelector('#modal-root [data-form="guest-book"]');
        var e = f.querySelector('[name="adults"]'); e.value = '4'; e.dispatchEvent(new Event('change', { bubbles: true })); })()`
    ]
  },
  {
    name: '08-booked', vp: PHONE, wait: 500,
    do: [
      `(function () { var f = document.querySelector('#modal-root [data-form="guest-book"]');
        var e = f.querySelector('[name="adults"]'); e.value = '2'; e.dispatchEvent(new Event('change', { bubbles: true })); })()`,
      `document.querySelector('#modal-root [data-form="guest-book"]').requestSubmit()`
    ],
    log: `LHMS.db.reservations.filter(function (r) { return r.source === 'Guest app'; }).map(function (r) { return r.reference; }).join(',')`
  },
  {
    name: '09-guest-upcoming', vp: PHONE, wait: 600,
    do: [`LHMS.go('guest/stay')`, `LHMS.rerender()`,
      `(function () { var b = document.querySelector('.phone-body'); var i = b.innerText.search(/Upcoming|Next stay/i);
        if (i > 0) b.scrollTop = i * 2; })()`]
  },
  {
    name: '09b-order-modal', vp: PHONE, wait: 800,
    do: [`LHMS.go('guest/stay')`, `LHMS.rerender()`,
      `document.querySelector('[data-act="guest-order"][data-service="dining"]').click()`]
  },
  {
    name: '09c-order-filled', vp: PHONE, wait: 600,
    do: [
      `(function () { var f = document.querySelector('#modal-root [data-form="guest-order"]');
        var set = function (n, v) { var e = f.querySelector('[name="' + n + '"]'); e.value = v;
          e.dispatchEvent(new Event('change', { bubbles: true })); };
        set('qty_ina_jollof', '2'); set('qty_ina_suya', '1');
        var w = f.querySelector('[name="when"]'); w.selectedIndex = 2;
        w.dispatchEvent(new Event('change', { bubbles: true }));
        f.querySelector('[name="notes"]').value = 'No shellfish, please.';
        var m = document.querySelector('#modal-root .modal'); m.scrollTop = m.scrollHeight; })()`
    ]
  },
  {
    name: '09d-folio-after-order', vp: PHONE, wait: 900,
    do: [`document.querySelector('#modal-root [data-form="guest-order"]').requestSubmit()`,
      `LHMS.go('guest/folio')`, `LHMS.rerender()`],
    log: `LHMS.db.charges.filter(function (c) { return c.postedBy === 'Guest app'; }).map(function (c) { return c.description; }).join(' | ')`
  },
  {
    name: '09e-profile-loyalty', vp: PHONE, wait: 600,
    do: [`LHMS.go('guest/me')`, `LHMS.rerender()`]
  },
  {
    name: '09f-redeem-modal', vp: PHONE, wait: 900,
    do: [`document.querySelector('[data-act="guest-redeem"]').click()`]
  },
  {
    name: '09g-folio-after-redeem', vp: PHONE, wait: 900,
    do: [`document.querySelector('#modal-root [data-form="guest-redeem"]').requestSubmit()`,
      `LHMS.go('guest/folio')`, `LHMS.rerender()`],
    log: `JSON.stringify({ credit: LHMS.db.charges.filter(function (c) { return c.department === 'Loyalty'; }).map(function (c) { return c.amount; }), points: LHMS.get.guest('gst_1').loyaltyPoints })`
  },
  {
    name: '09h-spa-modal', vp: PHONE, wait: 900,
    do: [`LHMS.go('guest/stay')`, `LHMS.rerender()`,
      `document.querySelector('[data-act="guest-order"][data-service="spa"]').click()`,
      `(function () { var f = document.querySelector('#modal-root [data-form="guest-order"]');
        var e = f.querySelector('[name="qty_spa_signature"]'); e.value = '1';
        e.dispatchEvent(new Event('change', { bubbles: true })); })()`]
  },
  {
    name: '10-staff-reservations', vp: DESKTOP, wait: 800,
    do: [`LHMS.ui.closeModal()`,
      `LHMS.switchRole('Manager', 'apa')`, `LHMS.switchProperty('apa')`,
      `LHMS.go('reservations')`, `LHMS.rerender()`,
      `(function () { var ref = LHMS.db.reservations.filter(function (r) { return r.source === 'Guest app'; })[0];
        if (!ref) return; ref = ref.reference;
        var row = Array.prototype.slice.call(document.querySelectorAll('table.data tbody tr'))
          .filter(function (tr) { return tr.innerText.indexOf(ref) !== -1; })[0];
        if (row) row.scrollIntoView({ block: 'center' }); })()`
    ]
  },
  {
    name: '11-staff-today', vp: DESKTOP, wait: 900,
    do: [`LHMS.switchRole('Front Desk', 'agm')`, `LHMS.switchProperty('agm')`,
      `LHMS.go('today')`, `LHMS.rerender()`]
  },
  {
    name: '12-staff-booking', vp: DESKTOP, wait: 1400,
    do: [`location.hash = '#/booking/new'`]
  },
  {
    name: '13-staff-requests', vp: DESKTOP, wait: 900,
    do: [`LHMS.switchRole('Front Desk', 'agm')`, `LHMS.switchProperty('agm')`,
      `LHMS.go('requests')`, `LHMS.rerender()`,
      `(function () { var f = document.querySelector('[data-live="req-search"]');
        f.value = 'Jollof'; f.dispatchEvent(new Event('input', { bubbles: true })); })()`],
    log: `LHMS.db.tasks.filter(function (t) { return t.source === 'Guest app'; }).map(function (t) { return t.title; }).join(' | ')`
  },
  {
    name: '14-staff-folio', vp: DESKTOP, wait: 900,
    do: [
      `(function () { var r = LHMS.db.reservations.filter(function (x) { return x.guestId === 'gst_1' && x.status === 'In-house'; })[0];
        window.__stay = r && r.id; })()`,
      `LHMS.go('folio/' + window.__stay)`, `LHMS.rerender()`]
  },
  {
    name: '15-checkout-loyalty', vp: DESKTOP, wait: 900,
    do: [`LHMS.views.checkoutModal(window.__stay)`]
  },
  {
    name: '16-prices-rooms', vp: DESKTOP, wait: 900,
    do: [`LHMS.ui.closeModal()`, `LHMS.switchRole('Manager', 'agm')`, `LHMS.switchProperty('agm')`,
      `LHMS.go('prices')`, `LHMS.rerender()`],
    log: `JSON.stringify({ rows: document.querySelectorAll('table.data tbody tr').length, services: LHMS.price.services('room').length })`
  },
  {
    name: '17-prices-restaurants', vp: DESKTOP, wait: 700,
    do: [`document.querySelector('[data-act="price-cat"][data-cat="restaurant"]').click()`]
  },
  {
    name: '18-price-edit-modal', vp: DESKTOP, wait: 800,
    do: [`document.querySelector('[data-act="price-edit"]').click()`]
  },
  {
    name: '19-price-history', vp: DESKTOP, wait: 800,
    do: [`LHMS.ui.closeModal()`, `document.querySelector('[data-act="price-cat"][data-cat="room"]').click()`,
      `document.querySelector('[data-act="price-history"]').click()`],
    log: `LHMS.price.history(LHMS.price.services('room')[0].id).map(function (h) { return h.reason; }).join(' | ')`
  },
  {
    name: '20-price-service-focus', vp: DESKTOP, wait: 800,
    do: [`LHMS.ui.closeModal()`,
      `LHMS.go('prices/' + LHMS.price.services('hall')[0].id)`, `LHMS.rerender()`]
  },
  {
    name: '21-taxes', vp: DESKTOP, wait: 800,
    do: [`LHMS.go('taxes')`, `LHMS.rerender()`],
    log: `JSON.stringify(LHMS.price.rules().map(function (r) { return r.name + ' ' + r.pct + '%'; }))`
  },
  {
    name: '22-prices-revenue-role', vp: DESKTOP, wait: 800,
    do: [`LHMS.switchRole('Revenue', 'agm')`, `LHMS.go('prices')`, `LHMS.rerender()`]
  },
  {
    name: '23-price-saved', vp: DESKTOP, wait: 900,
    do: [
      `(function () { var row = LHMS.price.baseRow(LHMS.price.services('room')[0].id);
        window.__pid = row.id; window.__svc = row.serviceId;
        LHMS.uiActions['price-edit']({ getAttribute: function () { return row.id; } }); })()`,
      `(function () { var f = document.querySelector('#modal-root [data-form="price-edit"]');
        var set = function (n, v) { var e = f.querySelector('[name="' + n + '"]'); e.value = v;
          e.dispatchEvent(new Event('change', { bubbles: true })); };
        set('amount', '199000');
        set('reason', 'Diary review ahead of the December peak');
        f.querySelector('[name="confirm"]').checked = true; })()`,
      `document.querySelector('[data-act="price-save"]').click()`
    ],
    log: `JSON.stringify({
      newPrice: LHMS.price.priceRow(window.__pid).amount,
      history: LHMS.price.history(window.__svc).length,
      lastReason: LHMS.price.history(window.__svc)[0].reason,
      postedChargesKept: LHMS.db.charges.filter(function (c) { return c.department === 'Rooms'; })
        .map(function (c) { return c.unitPrice; }).filter(function (u) { return u === 199000; }).length
    })`
  },
  {
    name: '24-events-board', vp: DESKTOP, wait: 900,
    do: [`LHMS.switchRole('Manager', 'agm')`, `LHMS.switchProperty('agm')`,
      `LHMS.go('events/' + LHMS.db.events[0].date)`, `LHMS.rerender()`],
    log: `JSON.stringify({ day: location.hash, seeded: LHMS.db.events.length, halls: LHMS.halls().length, extras: LHMS.eventExtras().length })`
  },
  {
    name: '25-event-clash', vp: DESKTOP, wait: 900,
    do: [`document.querySelector('[data-act="event-new"]').click()`,
      `(function () { var f = document.querySelector('#modal-root [data-form="event-book"]');
        f.querySelector('#eb-title').value = 'Q4 partner conference';
        f.querySelector('#eb-organizer').value = 'Zenith Capital';
        var cb = f.querySelector('[data-addon]'); cb.checked = true;
        cb.dispatchEvent(new Event('change', { bubbles: true })); })()`],
    log: `document.querySelector('#eb-quote').innerText.replace(/\\s+/g, ' ').slice(0, 90)`
  },
  {
    name: '26-event-quote', vp: DESKTOP, wait: 900,
    do: [
      `(function () { var f = document.querySelector('#modal-root [data-form="event-book"]');
        var set = function (id, v) { var e = f.querySelector('#' + id); e.value = v;
          e.dispatchEvent(new Event('change', { bubbles: true })); };
        set('eb-date', LHMS.util.addDays(LHMS.db.events[0].date, 4));
        set('eb-start', '09:00'); set('eb-end', '15:00'); set('eb-guests', '120');
        var sel = f.querySelector('#eb-res');
        sel.selectedIndex = 1;
        sel.dispatchEvent(new Event('change', { bubbles: true })); })()`],
    log: `document.querySelector('#eb-quote').innerText.replace(/\\s+/g, ' ').slice(0, 190)`
  },
  {
    name: '27-event-created', vp: DESKTOP, wait: 1100,
    do: [`document.querySelector('[data-act="event-save"]').click()`],
    log: `JSON.stringify((function () {
      var e = LHMS.db.events.filter(function (x) { return x.title === 'Q4 partner conference'; })[0];
      if (!e) return 'not booked';
      var folio = LHMS.folio(e.reservationId);
      return { total: e.total, lines: e.lines.length, posted: e.charges.length, folioTotal: folio.total, depositDue: e.deposit };
    })())`
  },
  {
    name: '28-event-detail', vp: DESKTOP, wait: 900,
    do: [
      `(function () { var e = LHMS.db.events.filter(function (x) { return x.title === 'Q4 partner conference'; })[0];
        document.querySelector('[data-act="event-open"][data-event="' + e.id + '"]').click(); })()`
    ]
  },
  {
    name: '29-event-cancel-terms', vp: DESKTOP, wait: 900,
    do: [`LHMS.ui.closeModal()`,
      `(function () { var e = LHMS.db.events.filter(function (x) { return x.title === 'Q4 partner conference'; })[0];
        LHMS.uiActions['event-cancel']({ getAttribute: function () { return e.id; } }); })()`]
  },
  {
    name: '30-laundry-board', vp: DESKTOP, wait: 900,
    do: [`LHMS.ui.closeModal()`, `LHMS.switchRole('Housekeeping', 'agm')`,
      `LHMS.go('laundry')`, `LHMS.rerender()`],
    log: `JSON.stringify({ orders: LHMS.db.laundry.length, stages: LHMS.LAUNDRY_STAGES, cards: document.querySelectorAll('.board-card').length })`
  },
  {
    name: '31-laundry-order', vp: DESKTOP, wait: 1000,
    do: [`document.querySelector('[data-act="laundry-new"]').click()`,
      `(function () { var f = document.querySelector('#modal-root [data-form="laundry-order"]');
        var set = function (id, v) { var e = f.querySelector('#' + id); e.value = v;
          e.dispatchEvent(new Event('change', { bubbles: true })); };
        set('ld_qty_ld_shirt', '6'); set('ld_qty_ld_suit', '2');
        f.querySelector('#ld-express').checked = true;
        f.querySelector('#ld-express').dispatchEvent(new Event('change', { bubbles: true })); })()`],
    log: `document.querySelector('#ld-quote').innerText.replace(/\\s+/g, ' ').slice(0, 170)`
  },
  {
    name: '32-laundry-taken', vp: DESKTOP, wait: 1100,
    do: [`document.querySelector('[data-act="laundry-save"]').click()`],
    log: `JSON.stringify((function () {
      var o = LHMS.db.laundry[0];
      var folio = LHMS.folio(o.reservationId);
      return { ref: o.ref, room: o.roomNumber, total: o.total, charges: o.charges.length,
        folioTotal: folio.total, due: LHMS.util.timeOf(o.dueAt), eta: Math.round((new Date(o.dueAt) - Date.now()) / 3600000 * 10) / 10 };
    })())`
  },
  {
    name: '33-laundry-detail', vp: DESKTOP, wait: 900,
    do: [`document.querySelector('[data-act="laundry-open"]').click()`]
  },
  {
    name: '34-laundry-moved', vp: DESKTOP, wait: 1000,
    do: [`LHMS.ui.closeModal()`,
      `(function () { var o = LHMS.db.laundry[0];
        document.querySelector('[data-act="laundry-move"][data-order="' + o.id + '"]').click(); })()`],
    log: `JSON.stringify(LHMS.db.laundry.slice(0, 3).map(function (o) { return o.ref + ' ' + o.status; }))`
  },
  {
    name: '35-events-revenue-readonly', vp: DESKTOP, wait: 900,
    do: [`LHMS.switchRole('Revenue', 'agm')`, `LHMS.go('events')`, `LHMS.rerender()`]
  },
  {
    name: '36-invoices', vp: DESKTOP, wait: 1000,
    do: [`LHMS.switchRole('Manager', 'agm')`, `LHMS.go('invoices')`, `LHMS.rerender()`],
    log: `JSON.stringify((function () {
      var all = LHMS.invoicesOf('agm');
      return { documents: all.length, rows: document.querySelectorAll('table.data tbody tr').length,
        raised: LHMS.unbilledAcross('agm').length,
        statuses: all.map(function (i) { return i.number + ' ' + LHMS.invoiceMoney(i).status; }) };
    })())`
  },
  {
    name: '37-invoice-raised', vp: DESKTOP, wait: 1100,
    do: [`(function () {
      var pick = LHMS.unbilledAcross('agm').filter(function (row) {
        return row.res.status !== 'Cancelled' && row.res.status !== 'No-show' && row.lines.length > 1;
      })[0];
      window.__splitable = !!pick;
      if (!pick) return;
      document.querySelector('[data-act="inv-raise"][data-kind="folio"][data-id="' + pick.res.id + '"]').click();
    })()`],
    log: `JSON.stringify((function () {
      var inv = LHMS.db.invoices[LHMS.db.invoices.length - 1];
      var t = LHMS.invoiceMoney(inv);
      return { splitable: window.__splitable, number: inv.number, lines: inv.lines.length, total: t.total,
        status: t.status, stillOnFolio: LHMS.unbilledCharges(inv.reservationId).length, href: location.hash };
    })())`
  },
  {
    name: '38-invoice-split', vp: DESKTOP, wait: 900,
    do: [`document.querySelector('[data-act="inv-split"]').click()`,
      `(function () { var f = document.querySelector('#modal-root #inv-split-form');
        f.querySelector('[name="line_0"]').checked = true;
        f.querySelector('[name="notes"]').value = 'Company pays the first line, guest pays the rest'; })()`],
    log: `document.querySelectorAll('#inv-split-form [name^="line_"]').length + ' lines offered'`
  },
  {
    name: '39-invoice-split-done', vp: DESKTOP, wait: 1100,
    do: [`document.querySelector('[data-act="inv-split-save"]').click()`],
    log: `JSON.stringify((function () {
      var second = LHMS.db.invoices[LHMS.db.invoices.length - 1];
      var first = LHMS.db.invoices[LHMS.db.invoices.length - 2];
      return { original: first.number + ' ' + first.lines.length + ' lines ' + LHMS.invoiceMoney(first).total,
        split: second.number + ' ' + second.lines.length + ' lines ' + LHMS.invoiceMoney(second).total,
        addsUp: LHMS.invoiceMoney(first).total + LHMS.invoiceMoney(second).total };
    })())`
  },
  {
    name: '40-payment-taken', vp: DESKTOP, wait: 1200,
    do: [`document.querySelector('[data-act="inv-pay"]').click()`,
      `document.querySelector('#inv-pay-form [name="reconciled"]').checked = true`,
      `document.querySelector('[data-act="inv-pay-save"]').click()`],
    log: `JSON.stringify((function () {
      var inv = LHMS.get.invoice(location.hash.split('/')[2]);
      var t = LHMS.invoiceMoney(inv);
      var p = LHMS.invoicePayments(inv.id)[0];
      return { number: inv.number, status: t.status, balance: t.balance, receipt: p.receipt,
        reconciled: p.reconciled, method: p.method };
    })())`
  },
  {
    name: '41-invoice-paid', vp: DESKTOP, wait: 700,
    do: [`(function () { var c = document.querySelectorAll('.card');
      var target = Array.prototype.slice.call(c).filter(function (x) { return /Receipts against/.test(x.innerText); })[0];
      if (target) target.scrollIntoView({ block: 'center' }); })()`]
  },
  {
    name: '42-refund-modal', vp: DESKTOP, wait: 900,
    do: [`(function () { var inv = LHMS.get.invoice(location.hash.split('/')[2]);
      LHMS.uiActions['inv-refund']({ getAttribute: function () { return inv.id; } }); })()`,
      `(function () { var f = document.querySelector('#modal-root #inv-rfd-form');
        f.querySelector('[name="amount"]').value = '20000';
        f.querySelector('[name="reason"]').value = 'Line billed twice — returned without touching the receipt'; })()`]
  },
  {
    name: '43-invoice-refunded', vp: DESKTOP, wait: 1100,
    do: [`document.querySelector('[data-act="inv-refund-save"]').click()`],
    log: `JSON.stringify((function () {
      var inv = LHMS.get.invoice(location.hash.split('/')[2]);
      var t = LHMS.invoiceMoney(inv);
      return { status: t.status, paid: t.paid, refunded: t.refunded, settled: t.settled, balance: t.balance,
        receiptsStillOnFile: LHMS.invoicePayments(inv.id).length,
        refunds: LHMS.db.refunds.length };
    })())`
  },
  {
    name: '44-receipts', vp: DESKTOP, wait: 1000,
    do: [`LHMS.go('receipts')`, `LHMS.rerender()`],
    log: `JSON.stringify((function () {
      var p = LHMS.paymentsOf('agm');
      return { receipts: p.length, rows: document.querySelectorAll('table.data tbody tr').length,
        unreconciled: p.filter(function (x) { return !x.reconciled; }).length };
    })())`
  },
  {
    name: '45-receipts-reconciled', vp: DESKTOP, wait: 1000,
    do: [`(function () { var s = document.querySelector('[name="recon"]'); s.value = 'out';
      s.dispatchEvent(new Event('change', { bubbles: true })); })()`,
      `document.querySelector('[data-act="pay-reconcile"]').click()`],
    log: `JSON.stringify((function () {
      var s = document.querySelector('[name="recon"]'); s.value = 'all';
      s.dispatchEvent(new Event('change', { bubbles: true }));
      return { total: LHMS.paymentsOf('agm').length,
        reconciled: LHMS.paymentsOf('agm').filter(function (p) { return p.reconciled; }).length };
    })())`
  },
  {
    name: '46-folio-invoice-card', vp: DESKTOP, wait: 1000,
    do: [`(function () {
      var inv = LHMS.invoicesOf('agm').filter(function (i) { return i.reservationId; })[0];
      LHMS.go('folio/' + inv.reservationId); LHMS.rerender();
    })()`]
  },
  {
    name: '47-invoices-readonly', vp: DESKTOP, wait: 1000,
    do: [`LHMS.switchRole('Revenue', 'agm')`, `LHMS.go('invoices')`, `LHMS.rerender()`],
    log: `JSON.stringify({ canBill: LHMS.can('manage_billing'),
      buttons: document.querySelectorAll('[data-act="inv-raise"],[data-act="inv-pay"]').length })`
  },
  {
    name: '48-financials-month', vp: DESKTOP, wait: 1100,
    do: [`LHMS.switchRole('Manager', 'agm')`, `LHMS.go('financials')`, `LHMS.rerender()`],
    log: `JSON.stringify((function () {
      var f = LHMS.finance(30);
      var spill = [];
      document.querySelectorAll('.card *').forEach(function (el) {
        if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0)
          spill.push(el.className + ' :: ' + el.innerText.slice(0, 24).replace(/\\s+/g, ' '));
      });
      var dc = document.querySelector('.donut-center b');
      var hole = dc ? Math.round(dc.closest('.donut').clientWidth - 56) : 0;
      return { revenue: f.now.revenue, collected: f.now.collected, expenses: f.now.expenses,
        pending: f.now.expensesPending, net: f.now.net, outstanding: f.now.outstanding,
        kpis: document.querySelectorAll('.kpi').length, charts: document.querySelectorAll('svg.chart').length,
        depts: document.querySelectorAll('[data-act="fin-drill"]').length,
        donut: dc ? dc.innerText + ' in ' + dc.getBoundingClientRect().width + 'px of an ' + hole + 'px hole' : 'none',
        spill: spill.slice(0, 6) };
    })())`
  },
  {
    name: '48b-financials-departments', vp: DESKTOP, wait: 900,
    do: [`(function () { var c = document.querySelectorAll('.card');
      var t = Array.prototype.slice.call(c).filter(function (x) { return /Revenue by department/.test(x.innerText); })[0];
      if (t) t.scrollIntoView(); })()`]
  },
  {
    name: '48c-financials-rules', vp: DESKTOP, wait: 900,
    do: [`window.scrollTo(0, document.body.scrollHeight)`]
  },
  {
    name: '49-financials-year', vp: DESKTOP, wait: 1200,
    do: [`document.querySelector('[data-act="fin-range"][data-days="365"]').click()`],
    log: `JSON.stringify((function () {
      var f = LHMS.finance(365);
      var svg = document.querySelector('svg.chart');
      return { revenue: f.now.revenue, collected: f.now.collected, expenses: f.now.expenses, net: f.now.net,
        days: f.series.length, viewBox: svg && svg.getAttribute('viewBox'),
        labels: document.querySelectorAll('svg.chart text.axis-label').length };
    })())`
  },
  {
    name: '50-financials-drill', vp: DESKTOP, wait: 1200,
    do: [`(function () { var c = document.querySelectorAll('.card');
      var t = Array.prototype.slice.call(c).filter(function (x) { return /Revenue by department/.test(x.innerText); })[0];
      if (t) t.scrollIntoView({ block: 'center' }); })()`,
      `document.querySelectorAll('tr[data-act="fin-drill"]')[0].click()`],
    log: `JSON.stringify((function () {
      var f = LHMS.finance(365);
      var rows = document.querySelectorAll('tr[data-act="fin-open"]');
      var dept = document.querySelector('tr[data-act="fin-drill"][data-dept]').getAttribute('data-dept');
      var txns = LHMS.financeTxns(dept, f.period.from, f.period.to);
      var sum = txns.reduce(function (s, t) { return s + t.amount; }, 0);
      return { department: dept, statement: f.now.byDept[dept], drilled: sum, rows: rows.length,
        reconciles: sum === f.now.byDept[dept] };
    })())`
  },
  {
    name: '51-financials-today', vp: DESKTOP, wait: 1100,
    do: [`document.querySelector('[data-act="fin-range"][data-days="1"]').click()`],
    log: `JSON.stringify((function () {
      var f = LHMS.finance(1);
      return { revenue: f.now.revenue, collected: f.now.collected,
        charts: document.querySelectorAll('svg.chart').length,
        emptyState: document.querySelectorAll('.empty').length,
        outstanding: f.now.outstanding };
    })())`
  },
  {
    name: '52-expense-record', vp: DESKTOP, wait: 1100,
    do: [`LHMS.go('expenses')`, `LHMS.rerender()`, `document.querySelector('[data-act="exp-add"]').click()`,
      `(function () { var f = document.querySelector('#modal-root #exp-form');
        f.querySelector('[name="description"]').value = 'Chilled-water pump seal — Tower riser';
        f.querySelector('[name="amount"]').value = '215000';
        f.querySelector('[name="category"]').value = 'Repairs & maintenance';
        f.querySelector('[name="payee"]').value = 'HydroWorks Nigeria';
        f.querySelector('[name="attachment"]').value = 'HW-2026-118'; })()`],
    log: `JSON.stringify({ pending: LHMS.expensesOf('agm').filter(function (e) { return e.status === 'Pending'; }).length,
      fields: document.querySelectorAll('#exp-form [name]').length })`
  },
  {
    name: '53-expense-recorded', vp: DESKTOP, wait: 1200,
    do: [`document.querySelector('[data-act="exp-add-save"]').click()`],
    log: `JSON.stringify((function () {
      var e = LHMS.expensesOf('agm')[0];
      var f = LHMS.finance(30);
      return { newest: e.description, amount: e.amount, status: e.status, recordedBy: e.recordedBy,
        decidedBy: e.decidedBy, inResult: f.now.expenses, awaiting: f.now.expensesPending };
    })())`
  },
  {
    name: '54-expense-decide', vp: DESKTOP, wait: 1100,
    do: [`document.querySelector('[data-act="exp-decide"][data-decide="approve"]').click()`,
      `document.querySelector('#modal-root #exp-note').value = 'Checked against the supplier delivery note.'`],
    log: `JSON.stringify((function () {
      var m = document.querySelector('#modal-root .modal');
      return { title: m.querySelector('h2').innerText, rows: m.querySelectorAll('.detail-row').length };
    })())`
  },
  {
    name: '55-expense-approved', vp: DESKTOP, wait: 1300,
    do: [`document.querySelector('[data-act="exp-decide-save"]').click()`],
    log: `JSON.stringify((function () {
      var f = LHMS.finance(30);
      var decided = LHMS.db.expenses.filter(function (e) { return /Chilled-water pump/.test(e.description); })[0];
      return { status: decided.status, decidedBy: decided.decidedBy, note: decided.decisionNote,
        expenses: f.now.expenses, net: f.now.net, pendingCount: f.now.pendingCount };
    })())`
  },
  {
    name: '56-expenses-readonly', vp: DESKTOP, wait: 1100,
    do: [`LHMS.switchRole('Revenue', 'agm')`, `LHMS.go('expenses')`, `LHMS.rerender()`],
    log: `JSON.stringify({ canRecord: LHMS.can('record_expenses'), canApprove: LHMS.can('approve_expenses'),
      recordButtons: document.querySelectorAll('[data-act="exp-add"]').length,
      decideButtons: document.querySelectorAll('[data-act="exp-decide"]').length,
      rows: document.querySelectorAll('table.data tbody tr').length })`
  },
  {
    name: '57-expenses-housekeeping', vp: DESKTOP, wait: 1100,
    do: [`LHMS.switchRole('Housekeeping', 'agm')`, `LHMS.go('expenses')`, `LHMS.rerender()`],
    log: `JSON.stringify({ canRecord: LHMS.can('record_expenses'), canApprove: LHMS.can('approve_expenses'),
      recordButtons: document.querySelectorAll('[data-act="exp-add"]').length,
      decideButtons: document.querySelectorAll('[data-act="exp-decide"]').length,
      notice: document.querySelectorAll('.notice').length,
      financialsVisible: !!Array.prototype.slice.call(document.querySelectorAll('.nav-link'))
        .filter(function (a) { return /Financial dashboard/.test(a.innerText); }).length })`
  },
  {
    name: '58-expense-row-drawer', vp: DESKTOP, wait: 1100,
    do: [`document.querySelector('tr[data-act="exp-open"]').click()`],
    log: `JSON.stringify((function () {
      var d = document.querySelector('#modal-root .drawer');
      return { title: d.querySelector('h2').innerText, rows: d.querySelectorAll('.detail-row').length,
        foot: d.querySelectorAll('.drawer-foot button').length };
    })())`
  },
  {
    name: '59-fin-reports-month', vp: DESKTOP, wait: 1200,
    do: [`LHMS.switchRole('Manager', 'agm')`, `LHMS.go('fin-reports')`, `LHMS.rerender()`],
    log: `JSON.stringify((function () {
      var rep = LHMS.report('dept-revenue', 30);
      var st = LHMS.finance(30).now;
      var spill = [];
      document.querySelectorAll('.card *').forEach(function (el) {
        if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0)
          spill.push(el.className + ' :: ' + el.innerText.slice(0, 24).replace(/\\s+/g, ' '));
      });
      return { title: rep.title, picks: document.querySelectorAll('[data-act="rep-open"]').length,
        domRows: document.querySelectorAll('#report-sheet tbody tr:not(.report-total)').length,
        engineRows: rep.rows.length, totals: document.querySelector('#report-sheet .report-total').innerText.replace(/\\s+/g, ' '),
        agrees: rep.totals[1] === st.revenue,
        exports: document.querySelectorAll('[data-act="rep-csv"],[data-act="rep-excel"],[data-act="rep-pdf"]').length,
        bars: document.querySelectorAll('#report-sheet .progress').length,
        spill: spill.slice(0, 6) };
    })())`
  },
  {
    name: '59b-fin-reports-totals', vp: DESKTOP, wait: 900,
    do: [`(function () { var t = document.querySelector('#report-sheet .report-total');
      t.scrollIntoView({ block: 'center' }); })()`]
  },
  {
    name: '60-rep-service-revenue', vp: DESKTOP, wait: 1100,
    do: [`document.querySelector('[data-act="rep-open"][data-key="service-revenue"]').click()`],
    log: `JSON.stringify((function () {
      var rep = LHMS.report('service-revenue', 30);
      var noPrice = rep.rows.filter(function (r) { return r[5] === 'No price record'; }).length;
      return { rows: rep.rows.length, domRows: document.querySelectorAll('#report-sheet tbody tr:not(.report-total)').length,
        cols: rep.columns.map(function (c) { return c.label; }).join(' | '),
        totalCol: document.querySelector('#report-sheet .report-total').innerText.replace(/\\s+/g, ' '),
        handPosted: noPrice, bars: document.querySelectorAll('#report-sheet .progress').length };
    })())`
  },
  {
    name: '61-rep-daily-cash-year', vp: DESKTOP, wait: 1200,
    do: [`document.querySelector('[data-act="rep-open"][data-key="daily-cash"]').click()`,
      `document.querySelector('[data-act="rep-range"][data-days="365"]').click()`],
    log: `JSON.stringify((function () {
      var rep = LHMS.report('daily-cash', 365);
      var wrap = document.querySelector('#report-sheet .table-wrap');
      return { rows: rep.rows.length, domRows: document.querySelectorAll('#report-sheet tbody tr:not(.report-total)').length,
        quietDays: rep.rows.filter(function (r) { return r[2] === 0; }).length,
        net: rep.totals[6], scrollable: wrap.scrollHeight > wrap.clientHeight,
        stickyHead: getComputedStyle(document.querySelector('#report-sheet thead th')).position,
        chart: document.querySelectorAll('#report-sheet .progress').length };
    })())`
  },
  {
    name: '62-rep-outstanding-sorted', vp: DESKTOP, wait: 1200,
    do: [`document.querySelector('[data-act="rep-open"][data-key="outstanding"]').click()`,
      `document.querySelector('[data-act="rep-sort"][data-col="4"]').click()`],
    log: `JSON.stringify((function () {
      var rep = LHMS.report('outstanding', 365);
      var first = document.querySelector('#report-sheet tbody tr:not(.report-total)');
      var last = Array.prototype.slice.call(document.querySelectorAll('#report-sheet tbody tr:not(.report-total)')).pop();
      return { rows: rep.rows.length, arrow: document.querySelector('[data-act="rep-sort"][data-col="4"]').innerText.trim(),
        first: first ? first.innerText.replace(/\\s+/g, ' ').slice(0, 70) : 'none',
        last: last ? last.innerText.replace(/\\s+/g, ' ').slice(0, 70) : 'none',
        totals: document.querySelector('#report-sheet .report-total').innerText.replace(/\\s+/g, ' '),
        agrees: rep.totals[6] === LHMS.finance(365).now.outstanding };
    })())`
  },
  {
    name: '63-rep-custom-window', vp: DESKTOP, wait: 1200,
    do: [
      `(function () { var U = LHMS.util, t = LHMS.day;
        var set = function (n, v) { var e = document.querySelector('[data-change="rep-window"][name="' + n + '"]');
          e.value = v; e.dispatchEvent(new Event('change', { bubbles: true })); };
        set('from', U.addDays(t, -60)); set('to', U.addDays(t, -30)); })()`
    ],
    log: `JSON.stringify((function () {
      var rep = LHMS.reportBetween('outstanding', LHMS.util.addDays(LHMS.day, -60), LHMS.util.addDays(LHMS.day, -30));
      var chip = document.querySelector('.chip.blue');
      var sheet = document.querySelector('#report-sheet');
      return { window: rep.from + ' → ' + rep.to, rows: rep.rows.length,
        headWindow: document.querySelector('#report-sheet .card-head .tiny').innerText,
        segOn: document.querySelectorAll('.seg button.on').length,
        typedChip: chip ? chip.innerText : 'none',
        maxAge: Math.max.apply(null, rep.rows.map(function (r) { return r[7]; })),
        ages: sheet.querySelectorAll('tbody tr:not(.report-total)').length
          - Array.prototype.slice.call(sheet.querySelectorAll('tbody tr:not(.report-total) td:last-child'))
            .filter(function (td) { return td.innerText.trim() === '0'; }).length,
        invalid: sheet.innerText.indexOf('Invalid Date') !== -1,
        engineAgrees: rep.totals[6] === LHMS.financeCore.statement(LHMS.db, 'agm', rep.from, rep.to).outstanding };
    })())`
  },
  {
    name: '64-rep-empty-window', vp: DESKTOP, wait: 1200,
    do: [`document.querySelector('[data-act="rep-open"][data-key="discounts-refunds"]').click()`],
    log: `JSON.stringify((function () {
      var rep = LHMS.report('discounts-refunds', 365);
      var empty = document.querySelector('#report-sheet .empty');
      return { rows: rep.rows.length, empty: empty ? empty.innerText.replace(/\\s+/g, ' ').slice(0, 60) : 'NONE',
        note: document.querySelector('#report-sheet .notice').innerText.replace(/\\s+/g, ' ').slice(0, 90) };
    })())`
  },
  {
    name: '64b-rep-all-totals-lines', vp: DESKTOP, wait: 1100,
    do: [],
    log: `JSON.stringify((function () {
      // Every report's totals line, read out of the real table: a label written
      // into a date or money column must stay a label, not become "Invalid Date"
      // or "₦NaN".
      var lines = {}, bad = [];
      LHMS.REPORTS.forEach(function (r) {
        document.querySelector('[data-act="rep-open"][data-key="' + r.key + '"]').click();
        var t = document.querySelector('#report-sheet .report-total');
        var text = t ? t.innerText.replace(/\\s+/g, ' ').trim() : 'MISSING';
        lines[r.key] = text.slice(0, 70);
        if (/Invalid Date|NaN/.test(text)) bad.push(r.key);
      });
      return { reports: LHMS.REPORTS.length, bad: bad, first: lines['dept-revenue'],
        cash: lines['daily-cash'], price: lines['price-history'], reversals: lines['discounts-refunds'] };
    })())`
  },
  {
    name: '65-rep-price-history', vp: DESKTOP, wait: 1100,
    do: [`document.querySelector('[data-act="rep-open"][data-key="price-history"]').click()`,
      `document.querySelector('[data-act="rep-range"][data-days="30"]').click()`],
    log: `JSON.stringify((function () {
      var rep = LHMS.report('price-history', 365);
      var t = document.querySelector('#report-sheet .report-total');
      return { rows: rep.rows.length, reasons: rep.rows.filter(function (r) { return r[7]; }).length,
        pct: rep.rows.map(function (r) { return r[5]; }).join(','),
        totalLine: t ? t.innerText.replace(/\\s+/g, ' ') : 'none',
        domFirst: document.querySelector('#report-sheet tbody tr:not(.report-total)').innerText.replace(/\\s+/g, ' ').slice(0, 80) };
    })())`
  },
  {
    name: '66-rep-profitability', vp: DESKTOP, wait: 1100,
    do: [`document.querySelector('[data-act="rep-open"][data-key="profitability"]').click()`],
    log: `JSON.stringify((function () {
      var rep = LHMS.report('profitability', 365);
      return { months: rep.rows.length, net: rep.totals[4],
        agrees: rep.totals[4] === LHMS.finance(365).now.net,
        bars: document.querySelectorAll('#report-sheet .progress').length,
        totals: document.querySelector('#report-sheet .report-total').innerText.replace(/\\s+/g, ' ') };
    })())`
  },
  {
    name: '67-rep-locked-role', vp: DESKTOP, wait: 1100,
    do: [`LHMS.switchRole('Front Desk', 'agm')`, `LHMS.go('fin-reports')`, `LHMS.rerender()`],
    log: `JSON.stringify({ canSee: LHMS.canSeeReports(),
      denied: LHMS.report('dept-revenue', 30).denied,
      onScreen: document.title,
      reportSheet: document.querySelectorAll('#report-sheet').length,
      navLinks: Array.prototype.slice.call(document.querySelectorAll('.nav-link'))
        .filter(function (a) { return /Financial reports/.test(a.innerText); }).length })`
  },

  /* ---- §9 audit trail, §10 approvals register, the Auditor role ---- */
  {
    name: '68-fin-settings', vp: DESKTOP, wait: 1200,
    do: [`LHMS.signIn('ifeoma.okafor@aureliagrand.com', 'aurelia2026')`, `LHMS.go('fin-settings')`, `LHMS.rerender()`,
      `(function () { window.__clearToasts = function () {
        var r = document.getElementById('toast-root'); if (r) r.innerHTML = ''; }; })()`],
    log: `JSON.stringify((function () {
      var fin = LHMS.financeSettings();
      var badge = document.querySelector('.nav-link[href="#/fin-settings"] .nav-badge');
      return { role: LHMS.session.role, prefix: fin.invoicePrefix, days: fin.paymentDays,
        limit: fin.approvalAmount, ceiling: fin.discountPct,
        pending: LHMS.approvals('Pending').length,
        fields: document.querySelectorAll('#fin-set-form [name]').length,
        saveButtons: document.querySelectorAll('[data-act="fin-set-edit"]').length,
        approveButtons: document.querySelectorAll('[data-act="apr-approve"]').length,
        navBadge: badge ? badge.innerText : 'none',
        kpis: document.querySelectorAll('.kpi').length, rows: document.querySelectorAll('.list-row').length };
    })())`
  },
  {
    name: '68b-fin-settings-register', vp: DESKTOP, wait: 900,
    do: [`(function () { var c = Array.prototype.slice.call(document.querySelectorAll('.card'))
        .filter(function (x) { return /Approvals register/.test(x.innerText); })[0];
      if (c) c.scrollIntoView({ block: 'start' }); })()`]
  },
  {
    name: '69-fin-settings-readonly', vp: DESKTOP, wait: 1100,
    do: [`window.__clearToasts()`, `LHMS.switchRole('Revenue', 'agm')`, `LHMS.go('fin-settings')`, `LHMS.rerender()`,
      `(function () { var c = Array.prototype.slice.call(document.querySelectorAll('.card'))
        .filter(function (x) { return /Approvals register/.test(x.innerText); })[0];
      if (c) c.scrollIntoView({ block: 'start' }); })()`],
    log: `JSON.stringify({ canEdit: LHMS.can('manage_financial_settings'), canClear: LHMS.canApproveFinancial(),
      formFields: document.querySelectorAll('#fin-set-form [name]').length,
      saveButtons: document.querySelectorAll('[data-act="fin-set-edit"]').length,
      approveButtons: document.querySelectorAll('[data-act="apr-approve"]').length,
      noteFields: document.querySelectorAll('[id^="apr-note-"]').length,
      waitChips: document.querySelectorAll('.chip.amber').length,
      readOnlyNotice: document.querySelectorAll('.notice').length })`
  },
  {
    name: '70-price-held', vp: DESKTOP, wait: 1000,
    do: [`window.__clearToasts()`, `LHMS.switchRole('Revenue', 'agm')`, `LHMS.go('prices')`, `LHMS.rerender()`,
      `(function () { var row = LHMS.db.prices.filter(function (p) { return p.id === 'prc_ps_std'; })[0];
        window.__row = row; window.__was = row.amount;
        LHMS.uiActions['price-edit']({ getAttribute: function () { return row.id; } }); })()`,
      `(function () { var f = document.querySelector('#modal-root [data-form="price-edit"]');
        var set = function (n, v) { var e = f.querySelector('[name="' + n + '"]'); e.value = v;
          e.dispatchEvent(new Event('change', { bubbles: true })); };
        set('amount', '2050000');
        set('reason', 'Presidential Suite repriced for the December weddings diary');
        f.querySelector('[name="confirm"]').checked = true; })()`,
      `document.querySelector('[data-act="price-save"]').click()`],
    log: `JSON.stringify((function () {
      var held = LHMS.db.approvals[0];
      window.__apr = held.id;
      var t = document.querySelector('#toast-root .toast');
      return { askedFor: 2050000, previous: window.__was, stillOnRow: window.__row.amount,
        rowUnchanged: window.__row.amount === window.__was,
        heldKind: held.kind, heldStatus: held.status, heldBy: held.requestedBy, heldAmount: held.amount,
        pending: LHMS.approvals('Pending').length,
        historyRows: LHMS.price.history(window.__row.serviceId).length,
        toast: t ? t.innerText.replace(/\\s+/g, ' ') : 'none' };
    })())`
  },
  {
    name: '71-approval-confirm', vp: DESKTOP, wait: 1000,
    do: [`window.__clearToasts()`, `LHMS.switchRole('Manager', 'agm')`, `LHMS.go('fin-settings')`, `LHMS.rerender()`,
      `(function () { var e = document.getElementById('apr-note-' + window.__apr);
        if (e) e.value = 'Checked against the December diary — two weddings already on hold.'; })()`,
      `(function () { var b = document.querySelector('[data-act="apr-approve"][data-apr="' + window.__apr + '"]');
        if (!b) return; b.scrollIntoView({ block: 'center' }); b.click(); })()`],
    log: `JSON.stringify((function () {
      var m = document.querySelector('#modal-root .modal');
      return { title: m.querySelector('h2').innerText,
        text: m.innerText.replace(/\\s+/g, ' ').slice(0, 150),
        buttons: m.querySelectorAll('.modal-foot .btn').length,
        mine: LHMS.db.approvals.filter(function (a) { return a.id === window.__apr; })[0].status };
    })())`
  },
  {
    name: '72-approval-applied', vp: DESKTOP, wait: 1200,
    do: [`window.__clearToasts()`, `document.querySelector('#modal-root [data-confirm]').click()`],
    log: `JSON.stringify((function () {
      var a = LHMS.db.approvals.filter(function (x) { return x.id === window.__apr; })[0];
      var row = LHMS.db.prices.filter(function (p) { return p.id === 'prc_ps_std'; })[0];
      var h = LHMS.price.history(row.serviceId)[0];
      var t = document.querySelector('#toast-root .toast');
      return { status: a.status, decidedBy: a.decidedBy, note: a.decisionNote,
        rowNow: row.amount, moved: row.amount === 2050000,
        historyBy: h.by, historyTo: h.to, historyReason: h.reason,
        pending: LHMS.approvals('Pending').length,
        trail: LHMS.db.activity[0].action + ' · ' + LHMS.db.activity[0].actor,
        toast: t ? t.innerText.replace(/\\s+/g, ' ') : 'none' };
    })())`
  },
  {
    name: '73-discount-held', vp: DESKTOP, wait: 1000,
    do: [`window.__clearToasts()`, `LHMS.switchRole('Front Desk', 'agm')`,
      `(function () { window.__inv = LHMS.invoicesOf().filter(function (i) {
        var t = LHMS.invoiceMoney(i); return t.status !== 'Void' && t.total > 0; })[0]; })()`,
      `LHMS.go('invoices/' + window.__inv.id)`, `LHMS.rerender()`,
      `(function () { var b = document.querySelector('[data-act="inv-adjust"]');
        if (!b) return; b.scrollIntoView({ block: 'center' }); b.click(); })()`,
      `(function () { var f = document.querySelector('#modal-root #inv-adj-form');
        if (!f) return;
        window.__total = LHMS.invoiceMoney(window.__inv).total;
        var set = function (n, v) { var e = f.querySelector('[name="' + n + '"]'); e.value = v;
          e.dispatchEvent(new Event('change', { bubbles: true })); };
        set('amount', String(Math.round(window.__total * 0.2 / 50) * 50));
        set('label', 'Corporate block concession');
        set('reason', 'Agreed with the corporate office for the December block'); })()`,
      `document.querySelector('[data-act="inv-adjust-save"]').click()`],
    log: `JSON.stringify((function () {
      var held = LHMS.db.approvals[0];
      var t = document.querySelector('#toast-root .toast');
      return { invoiceTotal: window.__total, ceilingPct: LHMS.financeSettings().discountPct,
        heldKind: held.kind, heldStatus: held.status, heldAmount: held.amount,
        heldPct: Math.round(held.amount / window.__total * 100),
        totalStillWhole: LHMS.invoiceMoney(window.__inv).total === window.__total,
        adjustments: window.__inv.adjustments.length,
        pending: LHMS.approvals('Pending').length,
        toast: t ? t.innerText.replace(/\\s+/g, ' ') : 'none' };
    })())`
  },
  {
    name: '74-approval-sent-back', vp: DESKTOP, wait: 1200,
    do: [`window.__clearToasts()`, `LHMS.switchRole('Manager', 'agm')`, `LHMS.go('fin-settings')`, `LHMS.rerender()`,
      `(function () { var e = document.getElementById('apr-note-apr_seed_discount');
        if (e) e.value = 'Not at 15% of a block total — take it through the corporate agreement.'; })()`,
      `document.querySelector('[data-act="apr-reject"][data-apr="apr_seed_discount"]').click()`,
      `document.querySelector('[data-act="apr-side"][data-side="decided"]').click()`],
    log: `JSON.stringify((function () {
      var a = LHMS.db.approvals.filter(function (x) { return x.id === 'apr_seed_discount'; })[0];
      var inv = LHMS.db.invoices.filter(function (i) { return i.id === a.change.invoiceId; })[0];
      var t = document.querySelector('#toast-root .toast');
      return { status: a.status, decidedBy: a.decidedBy, note: a.decisionNote,
        nothingApplied: inv.adjustments.filter(function (x) { return x.reason === a.reason; }).length,
        pending: LHMS.approvals('Pending').length,
        decidedRows: document.querySelectorAll('.list-row').length,
        waitingTab: document.querySelector('[data-act="apr-side"][data-side="waiting"]').innerText,
        toast: t ? t.innerText.replace(/\\s+/g, ' ') : 'none' };
    })())`
  },
  {
    name: '74b-approvals-decided', vp: DESKTOP, wait: 900,
    do: [`window.__clearToasts()`,
      `(function () { var c = Array.prototype.slice.call(document.querySelectorAll('.card'))
        .filter(function (x) { return /Approvals register/.test(x.innerText); })[0];
      if (c) c.scrollIntoView({ block: 'start' }); })()`],
    log: `JSON.stringify((function () {
      return { tab: document.querySelector('[data-act="apr-side"][data-side="decided"]').innerText,
        statuses: Array.prototype.slice.call(document.querySelectorAll('.list-row .chip')).map(function (c) { return c.innerText; }).join(','),
        lines: Array.prototype.slice.call(document.querySelectorAll('.list-row .lr-sub.tiny')).map(function (d) { return d.innerText; }).join(' || ') };
    })())`
  },
  {
    name: '75-settings-save-modal', vp: DESKTOP, wait: 1100,
    do: [`window.__clearToasts()`, `LHMS.go('fin-settings')`, `LHMS.rerender()`,
      `(function () { var f = document.querySelector('#fin-set-form');
        var set = function (n, v) { var e = f.querySelector('[name="' + n + '"]'); e.value = v;
          e.dispatchEvent(new Event('change', { bubbles: true })); };
        set('invoicePrefix', 'agos 1'); set('paymentDays', '14');
        set('approvalAmount', '750000'); set('discountPct', '15');
        document.querySelector('[data-act="fin-set-edit"]').scrollIntoView({ block: 'center' }); })()`,
      `document.querySelector('[data-act="fin-set-edit"]').click()`],
    log: `JSON.stringify((function () {
      var m = document.querySelector('#modal-root .modal');
      return { title: m.querySelector('h2').innerText,
        text: m.innerText.replace(/\\s+/g, ' ').slice(0, 220),
        savedYet: JSON.stringify(LHMS.financeSettings()) };
    })())`
  },
  {
    name: '76-settings-saved', vp: DESKTOP, wait: 1200,
    do: [`window.__clearToasts()`, `document.querySelector('#modal-root [data-confirm="fin-set-save"]').click()`],
    log: `JSON.stringify((function () {
      var fin = LHMS.financeSettings();
      var t = document.querySelector('#toast-root .toast');
      var line = LHMS.db.activity.filter(function (a) { return a.entity === 'financial settings'; })[0];
      return { prefix: fin.invoicePrefix, days: fin.paymentDays, limit: fin.approvalAmount,
        ceiling: fin.discountPct,
        headShowsPrefix: document.querySelector('.page-sub').innerText.indexOf('AGOS1-INV-0000') !== -1,
        trailLine: line ? line.actor + ' · ' + line.detail : 'none',
        heldKeptOldLimit: LHMS.approvals('Pending').map(function (a) { return a.amount; }).join(','),
        toast: t ? t.innerText.replace(/\\s+/g, ' ') : 'none' };
    })())`
  },
  {
    name: '77-fin-settings-auditor', vp: DESKTOP, wait: 1200,
    do: [`window.__clearToasts()`, `LHMS.switchRole('Auditor', 'agm')`, `LHMS.go('fin-settings')`, `LHMS.rerender()`],
    log: `JSON.stringify((function () {
      var nav = Array.prototype.slice.call(document.querySelectorAll('.nav-link')).map(function (a) {
        return a.innerText.replace(/\\s+/g, ' ').trim(); });
      return { role: LHMS.session.role, name: LHMS.session.name, heading: document.querySelector('.page-head h1').innerText,
        canSeeSettings: nav.filter(function (n) { return /Financial settings/.test(n); }).length,
        canSeeAudit: nav.filter(function (n) { return /Audit trail/.test(n); }).length,
        canSeeReports: nav.filter(function (n) { return /Financial reports/.test(n); }).length,
        canEdit: LHMS.can('manage_financial_settings'),
        canClear: LHMS.canApproveFinancial(), formFields: document.querySelectorAll('#fin-set-form [name]').length,
        approveButtons: document.querySelectorAll('[data-act="apr-approve"]').length,
        noteFields: document.querySelectorAll('[id^="apr-note-"]').length,
        chips: Array.prototype.slice.call(document.querySelectorAll('.chip')).map(function (c) { return c.innerText; }).join(' | '),
        nav: nav.join(', ') };
    })())`
  },
  {
    name: '78-fin-audit-trail', vp: DESKTOP, wait: 1200,
    do: [`LHMS.go('fin-audit')`, `LHMS.rerender()`],
    log: `JSON.stringify((function () {
      var shown = {};
      Array.prototype.slice.call(document.querySelectorAll('.audit-entity')).forEach(function (e) {
        shown[e.innerText] = (shown[e.innerText] || 0) + 1; });
      var opts = Array.prototype.slice.call(document.querySelectorAll('[data-change="act-entity"] option'))
        .map(function (o) { return o.value; });
      return { title: document.querySelector('.page-head h1').innerText,
        eyebrow: document.querySelector('.page-head .eyebrow').innerText,
        days: document.querySelectorAll('.audit-day').length,
        rows: document.querySelectorAll('.audit-row').length,
        entitiesOnPage: Object.keys(shown).sort().join(','),
        entityOptions: opts.join(','),
        moneyOnly: opts.filter(function (o) { return ['folio', 'reservation', 'guest', 'housekeeping'].indexOf(o) === -1; }).length };
    })())`
  },
  {
    name: '79-activity-all-entities', vp: DESKTOP, wait: 1200,
    do: [`LHMS.go('activity')`, `LHMS.rerender()`],
    log: `JSON.stringify((function () {
      var opts = Array.prototype.slice.call(document.querySelectorAll('[data-change="act-entity"] option'))
        .map(function (o) { return o.value; });
      return { title: document.querySelector('.page-head h1').innerText,
        defaultOption: document.querySelector('[data-change="act-entity"]').value,
        rows: document.querySelectorAll('.audit-row').length,
        entityOptions: opts.join(','),
        nonMoney: opts.filter(function (o) { return ['folio', 'reservation', 'guest', 'housekeeping'].indexOf(o) !== -1; }).length };
    })())`
  },
  {
    name: '80-eod-open', vp: DESKTOP, wait: 1200,
    do: [`LHMS.signIn('ifeoma.okafor@aureliagrand.com', 'aurelia2026')`,
      `(function () { var r = LHMS.db.reservations.filter(function (x) { return x.status === 'In-house' && x.propertyId === 'agm'; })[0];
        r.checkOut = LHMS.bizDay();
        LHMS.db.charges = LHMS.db.charges.filter(function (c) { return !(c.reservationId === r.id && c.date === LHMS.bizDay()); });
        LHMS.save(); window.__overstay = r.id; })()`,
      `LHMS.go('end-of-day')`, `LHMS.rerender()`,
      `(function () { window.__clearToasts = function () { var t = document.getElementById('toast-root'); if (t) t.innerHTML = ''; };
        window.__tick = function (k) { var b = document.querySelector('[data-eod-check][data-key="' + k + '"]'); if (b && !b.checked) b.click(); return !!b; };
        window.__toast = function () { var t = document.querySelectorAll('.toast'); return t.length ? t[t.length - 1].innerText.trim() : 'none'; }; })()`],
    log: `JSON.stringify((function () {
      var pack = LHMS.auditPack();
      return { day: LHMS.bizDay(), canClose: LHMS.can('night_audit'),
        controls: LHMS.auditChecks().length, unbilled: pack.unbilled.length,
        unbilledTotal: pack.unbilledTotal,
        kpis: Array.prototype.slice.call(document.querySelectorAll('.kpi-label')).map(function (x) { return x.innerText; }).join('|'),
        closeDisabled: document.querySelector('[data-act="eod-close-open"]').disabled,
        sealedCards: Array.prototype.slice.call(document.querySelectorAll('.card-title')).map(function (x) { return x.innerText; }).join('|') };
    })())`
  },
  {
    name: '81-eod-partial', vp: DESKTOP, wait: 900,
    do: [`__tick('arrivals')`, `__tick('folios')`, `__tick('roomtax')`],
    log: `JSON.stringify((function () {
      var bar = document.querySelector('.progress span');
      return { ticked: document.querySelectorAll('[data-eod-check]:checked').length,
        total: document.querySelectorAll('[data-eod-check]').length,
        progress: bar ? bar.getAttribute('style') : 'none',
        pending: Array.prototype.slice.call(document.querySelectorAll('.chip')).filter(function (c) { return c.innerText === 'Pending'; }).length };
    })())`
  },
  {
    name: '82-eod-close-refused', vp: DESKTOP, wait: 1100,
    do: [`window.__clearToasts()`, `document.querySelector('[data-act="eod-close-open"]').click()`,
      `document.querySelector('[data-confirm="eod-close"]').click()`],
    log: `JSON.stringify((function () {
      var pack = LHMS.auditPack();
      return { toast: window.__toast(), closedDays: LHMS.db.closedDays.length, dayStill: LHMS.bizDay(),
        unbilledStill: pack.unbilled.length, modalOpen: !!document.querySelector('.modal') };
    })())`
  },
  {
    name: '83-eod-all-confirmed', vp: DESKTOP, wait: 1000,
    do: [`document.querySelector('[data-close-modal]').click()`,
      `__tick('payments')`, `__tick('housekeeping')`, `__tick('revenue')`, `__tick('audit')`, `__tick('currency')`,
      `(function () { var c = Array.prototype.slice.call(document.querySelectorAll('.card'))
        .filter(function (x) { return /Room money this run posts/.test(x.innerText); })[0];
        if (c) c.scrollIntoView({ block: 'start' }); })()`],
    log: `JSON.stringify((function () {
      var pack = LHMS.auditPack();
      return { ticked: document.querySelectorAll('[data-eod-check]:checked').length,
        of: document.querySelectorAll('[data-eod-check]').length,
        unbilledRows: document.querySelectorAll('.chip.amber').length,
        unbilledTotal: pack.unbilledTotal,
        roomtaxDetail: (LHMS.auditChecks().filter(function (c) { return c.key === 'roomtax'; })[0] || {}).detail };
    })())`
  },
  {
    name: '84-eod-confirm-pack', vp: DESKTOP, wait: 1000,
    do: [`document.querySelector('[data-act="eod-close-open"]').click()`],
    log: `JSON.stringify((function () {
      var m = document.querySelector('.modal');
      return { title: m.querySelector('h2').innerText, body: m.querySelector('.modal-body').innerText.slice(0, 320),
        label: m.querySelector('[data-confirm="eod-close"]').innerText };
    })())`
  },
  {
    name: '85-eod-rolled', vp: DESKTOP, wait: 1400,
    do: [`window.__clearToasts()`, `document.querySelector('[data-confirm="eod-close"]').click()`,
      `window.__sealed = LHMS.db.closedDays[LHMS.db.closedDays.length - 1].date`],
    log: `JSON.stringify((function () {
      var c = LHMS.db.closedDays[0];
      var card = Array.prototype.slice.call(document.querySelectorAll('.card'))
        .filter(function (x) { return /Room money this run posts/.test(x.innerText); })[0];
      return { toast: window.__toast(), sealedDay: c.date, rolledTo: LHMS.bizDay(),
        posted: c.posted.length, postedTotal: c.postedTotal, sealedCharges: c.stats.charges,
        folioTotal: LHMS.folio(window.__overstay).total,
        checksCarriedOver: document.querySelectorAll('[data-eod-check]:checked').length,
        nextNightUnbilled: LHMS.auditPack().unbilled.length,
        cardSub: card ? card.querySelector('.card-sub').innerText : 'missing',
        notice: (document.querySelector('.notice.success') || {}).innerText };
    })())`
  },
  {
    name: '86-eod-seal-list', vp: DESKTOP, wait: 900,
    do: [`(function () { var c = Array.prototype.slice.call(document.querySelectorAll('.card'))
        .filter(function (x) { return /Sealed business dates/.test(x.innerText); })[0];
      if (c) c.scrollIntoView({ block: 'start' }); })()`],
    log: `JSON.stringify((function () {
      var closed = LHMS.closedOn(window.__sealed);
      var card = Array.prototype.slice.call(document.querySelectorAll('.card'))
        .filter(function (x) { return /Sealed business dates/.test(x.innerText); })[0];
      return { cardText: card ? card.innerText.replace(/\\s+/g, ' ').slice(0, 220) : 'missing',
        isClosed: LHMS.dayIsClosed(window.__sealed), todayOpen: LHMS.dayIsClosed(LHMS.bizDay()),
        by: closed.by, rolledTo: closed.rolledTo };
    })())`
  },
  {
    name: '87-eod-backdate-blocked', vp: DESKTOP, wait: 1200,
    do: [`window.__clearToasts()`,
      `LHMS.go('folio/' + window.__overstay)`, `LHMS.rerender()`,
      `document.querySelector('[data-act="open-post-charge"]').click()`,
      `(function () { var f = document.querySelector('form[data-form="post-charge"]');
        f.querySelector('[name="description"]').value = 'Late minibar — dated yesterday';
        f.querySelector('[name="amount"]').value = '45000';
        f.querySelector('[name="date"]').value = window.__sealed; })()`,
      `document.querySelector('[data-act="submit-charge"]').click()`],
    log: `JSON.stringify((function () {
      var before = LHMS.db.charges.length;
      return { toast: window.__toast(), charges: before,
        landedOnSealedDay: LHMS.db.charges.filter(function (c) { return /Late minibar/.test(c.description); }).length };
    })())`
  },
  {
    name: '88-eod-void-blocked', vp: DESKTOP, wait: 1200,
    do: [`window.__clearToasts()`,
      `(function () { var id = null; LHMS.db.charges.forEach(function (c) {
          if (c.date === window.__sealed && c.reservationId === window.__overstay && !c.voided) id = c.id; });
        window.__sealCharge = id;
        var b = id ? document.querySelector('[data-act="void-charge"][data-charge="' + id + '"]') : null;
        if (b) b.click(); })()`,
      // The void button only opens the confirm; the sealed-day refusal is the
      // confirm's answer, so the run has to press it to reach the guard.
      `document.querySelector('[data-confirm="yes"]').click()`],
    log: `JSON.stringify((function () {
      var c = LHMS.db.charges.filter(function (x) { return x.id === window.__sealCharge; })[0] || {};
      return { target: !!window.__sealCharge, toast: window.__toast(), voided: c.voided,
        voidedBy: c.voidedBy, folioTotalStill: LHMS.folio(window.__overstay).total,
        modalStillOpen: !!document.querySelector('.modal') };
    })())`
  },
  {
    name: '89-eod-house-moved', vp: DESKTOP, wait: 1200,
    do: [`LHMS.go('financials')`, `LHMS.rerender()`],
    log: `JSON.stringify((function () {
      var fin = LHMS.finance(7);
      return { eyebrow: document.querySelector('.page-head .eyebrow').innerText,
        periodFrom: fin.period.from, periodTo: fin.period.to, businessDay: LHMS.bizDay(),
        chargesToday: LHMS.auditPack().charges.length, sealed: LHMS.db.closedDays.length };
    })())`
  },
  {
    name: '90-frontdesk-charge-posted', vp: DESKTOP, wait: 1200,
    do: [`window.__clearToasts()`, `LHMS.go('folio/' + window.__overstay)`, `LHMS.rerender()`,
      `document.querySelector('[data-act="open-post-charge"]').click()`,
      `(function () { window.__before = LHMS.folio(window.__overstay).total;
        var f = document.querySelector('form[data-form="post-charge"]');
        f.querySelector('[name="description"]').value = 'Terrace dinner — posted on the open day';
        f.querySelector('[name="amount"]').value = '45000'; })()`,
      `document.querySelector('[data-act="submit-charge"]').click()`],
    log: `JSON.stringify((function () {
      var f = LHMS.folio(window.__overstay);
      return { toast: window.__toast(), modalClosed: !document.querySelector('.modal'),
        posted: f.total - window.__before, total: f.total };
    })())`
  },
  {
    name: '91-frontdesk-payment-posted', vp: DESKTOP, wait: 1200,
    do: [`window.__clearToasts()`, `LHMS.rerender()`,
      `document.querySelector('[data-act="open-payment"]').click()`,
      `(function () { window.__paidBefore = LHMS.folio(window.__overstay).paid;
        var f = document.querySelector('form[data-form="take-payment"]');
        window.__prefill = f.querySelector('[name="amount"]').value; })()`,
      `document.querySelector('[data-act="submit-payment"]').click()`],
    log: `JSON.stringify((function () {
      var f = LHMS.folio(window.__overstay);
      return { toast: window.__toast(), prefill: window.__prefill,
        paid: f.paid - window.__paidBefore, balance: f.balance };
    })())`
  },
  {
    name: '92-bulk-modal', vp: DESKTOP, wait: 1000,
    do: [`(function () { window.__clearToasts = function () { var t = document.getElementById('toast-root'); if (t) t.innerHTML = ''; };
      window.__toast = function () { var t = document.querySelectorAll('.toast'); return t.length ? t[t.length - 1].innerText.trim() : 'none'; }; })()`,
      `LHMS.signIn('chiamaka.obi@aureliagrand.com', 'demo1234')`,
      `LHMS.switchRole('Revenue', 'agm')`, `LHMS.go('prices')`, `LHMS.rerender()`,
      `document.querySelector('[data-act="price-cat"][data-cat="room"]').click()`,
      `document.querySelector('[data-act="price-import"]').click()`],
    log: `JSON.stringify((function () {
      var m = document.querySelector('#modal-root .modal');
      return { title: m.querySelector('h2').innerText,
        body: m.innerText.replace(/\\s+/g, ' ').slice(0, 200),
        fields: Array.prototype.slice.call(m.querySelectorAll('[name]')).map(function (e) { return e.name; }).join(','),
        foot: Array.prototype.slice.call(m.querySelectorAll('.modal-foot .btn')).map(function (b) { return b.innerText.trim() + (b.disabled ? ' (off)' : ''); }).join(' | '),
        applyDisabled: document.querySelector('[data-act="price-import-apply"]').disabled };
    })())`
  },
  {
    name: '93-bulk-paste', vp: DESKTOP, wait: 700,
    do: [
      `(function () {
        var NL = String.fromCharCode(10);
        var price = function (id) { return LHMS.db.prices.filter(function (p) { return p.id === id; })[0]; };
        var q = function (v) { v = String(v); return /["',]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
        var head = ['Price ID', 'Service', 'Code', 'Category', 'Price list', 'Amount', 'Currency',
          'Effective from', 'Effective to', 'Status'].concat(LHMS.price.surchargeFields('room'));
        var line = function (p, amount, status) {
          var svc = LHMS.db.services.filter(function (s) { return s.id === p.serviceId; })[0];
          var list = LHMS.db.priceLists.filter(function (l) { return l.id === p.listId; })[0];
          return [p.id, svc.name, svc.code, svc.category, list.name, amount, p.currency,
            p.from || '', p.to || '', status]
            .concat(LHMS.price.surchargeFields('room').map(function (f) {
              var v = (p.surcharges || {})[f]; return v === undefined || v === null ? '' : v; }))
            .map(q).join(',');
        };
        var fest = price('prc_dk_fest'), ps = price('prc_ps_std'), dk = price('prc_dk_std');
        window.__festWas = fest.amount; window.__psWas = ps.amount;
        window.__pendingBefore = LHMS.approvals('Pending').length;
        window.__csv = [head.map(q).join(',')
          , line(fest, fest.amount + 40000, 'on sale')
          , line(ps, 3100000, 'on sale')
          , line(dk, dk.amount, 'on sale')
          , 'prc_ghost_std,Unicorn Suite,UC1,room,Standard Rate,150000,NGN,,,on sale'].join(NL);
      })()`,
      `(function () { var f = document.querySelector('#modal-root [data-form="price-import"]');
        f.querySelector('[name="csv"]').value = window.__csv;
        f.querySelector('[name="reason"]').value = 'December diary review — festive rack rate and the suite'; })()`
    ],
    log: `JSON.stringify({ lines: window.__csv.split(String.fromCharCode(10)).length, pasted: document.querySelector('#import-form [name="csv"]').value.length })`
  },
  {
    name: '94-bulk-review', vp: DESKTOP, wait: 900,
    do: [`document.querySelector('[data-act="price-import-plan"]').click()`,
      `(function () { var m = document.querySelector('#modal-root .modal'); m.scrollTop = m.scrollHeight; })()`],
    log: `JSON.stringify((function () {
      var plan = LHMS.price.planImport(window.__csv, 'December diary review — festive rack rate and the suite');
      return { counts: plan.counts,
        chips: Array.prototype.slice.call(document.querySelectorAll('#import-preview .chip')).map(function (c) { return c.innerText; }).join(' | '),
        tableRows: document.querySelectorAll('#import-preview table.data tbody tr').length,
        foot: Array.prototype.slice.call(document.querySelectorAll('.modal-foot .btn')).map(function (b) { return b.innerText.trim() + (b.disabled ? ' (off)' : ''); }).join(' | '),
        toast: window.__toast() };
    })())`
  },
  {
    name: '95-bulk-applied', vp: DESKTOP, wait: 1200,
    do: [`window.__clearToasts()`, `document.querySelector('[data-act="price-import-apply"]').click()`],
    log: `JSON.stringify((function () {
      var fest = LHMS.db.prices.filter(function (p) { return p.id === 'prc_dk_fest'; })[0];
      var ps = LHMS.db.prices.filter(function (p) { return p.id === 'prc_ps_std'; })[0];
      var held = LHMS.db.approvals.filter(function (a) { return a.status === 'Pending'; })
        .filter(function (a) { return a.subjectId === 'prc_ps_std'; })[0];
      var act = LHMS.db.activity.filter(function (a) { return /imported prices/.test(a.action); })[0];
      return { festWas: window.__festWas, festNow: fest.amount,
        psHeld: held ? held.amount : 'not queued', psRowStill: ps.amount, psUnchanged: ps.amount === window.__psWas,
        pendingDelta: LHMS.approvals('Pending').length - window.__pendingBefore,
        history: LHMS.price.history('svc_dk').length,
        audit: act ? act.action + ' · ' + act.detail : 'none',
        toast: window.__toast(), modalClosed: !document.querySelector('#modal-root .modal') };
    })())`
  },
  {
    name: '96-bulk-table-holds', vp: DESKTOP, wait: 900,
    do: [`(function () { var row = Array.prototype.slice.call(document.querySelectorAll('table.data tbody tr'))
        .filter(function (tr) { return /Festive/.test(tr.innerText); })[0];
      if (row) row.scrollIntoView({ block: 'center' }); })()`],
    log: `JSON.stringify((function () {
      var rows = Array.prototype.slice.call(document.querySelectorAll('table.data tbody tr'));
      return { visible: rows.length,
        festive: (rows.filter(function (t) { return /Festive/.test(t.innerText); })[0] || {}).innerText
          ? rows.filter(function (t) { return /Festive/.test(t.innerText); })[0].innerText.replace(/\\s+/g, ' ').slice(0, 120) : 'row not on this tab',
        suite: (rows.filter(function (t) { return /Presidential/.test(t.innerText); })[0] || { innerText: 'not listed' }).innerText.replace(/\\s+/g, ' ').slice(0, 120) };
    })())`
  },
  {
    name: '97-fx-rates-card', vp: DESKTOP, wait: 1300,
    do: [`LHMS.signIn('ifeoma.okafor@aureliagrand.com', 'aurelia2026')`, `LHMS.go('fin-settings')`,
      `(function () { window.__clearToasts = function () { var t = document.getElementById('toast-root'); if (t) t.innerHTML = ''; };
        window.__toast = function () { var t = document.querySelector('.toast'); return t ? t.innerText.replace(/\\s+/g, ' ').trim() : 'none'; };
        window.__kpi = function (re) {
          var l = Array.prototype.slice.call(document.querySelectorAll('.kpi-label')).filter(function (x) { return re.test(x.innerText); })[0];
          return l ? l.parentElement.innerText.replace(/\\s+/g, ' ').slice(0, 90) : 'missing'; };
        window.__clearToasts(); })()`,
      `(function () {
        var r = LHMS.db.reservations.filter(function (x) { return x.status === 'In-house' && x.propertyId === 'agm'; })[0];
        window.__fxRes = r.id; window.__fxRoom = r.roomTypeId;
        var svc = LHMS.price.forRef('room', r.roomTypeId);
        window.__fxPrice = LHMS.price.baseRow(svc.id).id;
        LHMS.actions.setPrice(window.__fxPrice, { currency: 'USD', amount: 400 }, 'Suites sold in dollars');
        LHMS.save(); })()`,
      `LHMS.rerender()`,
      `(function () { var c = Array.prototype.slice.call(document.querySelectorAll('.card'))
        .filter(function (x) { return /Exchange rates/.test(x.innerText); })[0];
        if (c) c.scrollIntoView({ block: 'start' }); })()`],
    log: `JSON.stringify((function () {
      var card = Array.prototype.slice.call(document.querySelectorAll('.card'))
        .filter(function (x) { return /Exchange rates/.test(x.innerText); })[0];
      return { day: LHMS.bizDay(), inCatalogue: LHMS.fx.inCatalogue().join('+'),
        base: LHMS.fx.base(), soldChips: Array.prototype.slice.call(document.querySelectorAll('.chip.gold')).length,
        chips: Array.prototype.slice.call(document.querySelectorAll('.card .chip')).map(function (c) { return c.innerText; }).join('|'),
        usdRow: card ? card.innerText.replace(/\\s+/g, ' ').match(/USD [^·]{0,90}/)[0] : 'missing',
        cardSub: card ? card.querySelector('.card-sub').innerText : 'missing',
        priceCurrency: LHMS.db.prices.filter(function (p) { return p.id === window.__fxPrice; })[0].currency };
    })())`
  },
  {
    name: '98-fx-rates-stale', vp: DESKTOP, wait: 1100,
    do: [`(function () {
        // Shortening the trust window is what makes the filed rate stale here: the
        // business date stays put, so the close is not buried under four days of
        // nights nobody ran.
        LHMS.actions.setFinanceSettings({ rateMaxAgeDays: 1 });
      })()`,
      `LHMS.rerender()`,
      `(function () { var c = Array.prototype.slice.call(document.querySelectorAll('.card'))
        .filter(function (x) { return /Exchange rates/.test(x.innerText); })[0];
        if (c) c.scrollIntoView({ block: 'start' }); })()`],
    log: `JSON.stringify((function () {
      var card = Array.prototype.slice.call(document.querySelectorAll('.card'))
        .filter(function (x) { return /Exchange rates/.test(x.innerText); })[0];
      return { day: LHMS.bizDay(), unusable: LHMS.fx.unusable().map(function (s) { return s.code + ':' + s.state; }).join('+'),
        danger: card && card.querySelector('.notice.danger') ? card.querySelector('.notice.danger').innerText.replace(/\\s+/g, ' ').slice(0, 200) : 'none',
        staleKpi: __kpi(/Rates to refresh/i),
        chips: Array.prototype.slice.call(document.querySelectorAll('.card .chip')).map(function (c) { return c.innerText; }).join('|'),
        quotedNight: LHMS.price.nightRateOf(window.__fxRoom) };
    })())`
  },
  {
    name: '99-fx-rate-filed', vp: DESKTOP, wait: 1200,
    do: [`window.__clearToasts()`,
      `(function () { var f = document.getElementById('fx-form');
        var set = function (n, v) { var e = f.querySelector('[name="' + n + '"]'); e.value = v;
          e.dispatchEvent(new Event('change', { bubbles: true })); };
        set('code', 'USD'); set('perBase', '1575'); set('effective', LHMS.bizDay());
        set('note', 'Group treasury fixing, 09:30');
        document.querySelector('[data-act="fx-file"]').scrollIntoView({ block: 'center' }); })()`,
      `document.querySelector('[data-act="fx-file"]').click()`],
    log: `JSON.stringify((function () {
      var m = document.querySelector('#modal-root .modal');
      return { title: m.querySelector('h2').innerText,
        text: m.innerText.replace(/\\s+/g, ' ').slice(0, 240),
        stateBefore: LHMS.fx.state('USD').state,
        stillHeld: LHMS.db.prices.filter(function (p) { return p.id === window.__fxPrice; })[0].amount };
    })())`
  },
  {
    name: '100-fx-rate-applied', vp: DESKTOP, wait: 1300,
    do: [`window.__clearToasts()`, `document.querySelector('#modal-root [data-confirm="fx-save"]').click()`,
      `(function () { var c = Array.prototype.slice.call(document.querySelectorAll('.card'))
        .filter(function (x) { return /Exchange rates/.test(x.innerText); })[0];
        if (c) c.scrollIntoView({ block: 'start' }); })()`],
    log: `JSON.stringify((function () {
      var line = LHMS.db.activity.filter(function (a) { return a.entity === 'currency'; })[0];
      return { toast: window.__toast(), state: LHMS.fx.state('USD').state,
        rate: LHMS.fx.state('USD').rate, age: LHMS.fx.state('USD').ageDays,
        trail: line ? line.actor + ' · ' + line.detail.replace(/\\s+/g, ' ') : 'none',
        quotedNight: LHMS.price.nightRateOf(window.__fxRoom),
        staleKpi: __kpi(/Rates to refresh/i),
        danger: !!document.querySelector('.card .notice.danger') };
    })())`
  },
  {
    name: '101-eod-nights-held', vp: DESKTOP, wait: 1300,
    do: [`window.__clearToasts()`,
      `(function () {
        // The dollar fixing is taken off the books entirely, and one suite is left
        // owing tonight in it: folio cleared, siblings in the same room type closed,
        // so the capture is about the money, not somebody else's stay.
        LHMS.db.fxRates = LHMS.db.fxRates.filter(function (r) { return r.code !== 'USD'; });
        var target = LHMS.db.reservations.filter(function (x) { return x.id === window.__fxRes; })[0];
        LHMS.db.reservations.forEach(function (x) {
          if (x.status === 'In-house' && x.roomTypeId === window.__fxRoom && x.id !== target.id) x.status = 'Checked out';
        });
        target.checkIn = LHMS.bizDay();
        LHMS.db.charges = LHMS.db.charges.filter(function (c) { return c.reservationId !== target.id; });
        LHMS.db.payments = LHMS.db.payments.filter(function (p) { return p.reservationId !== target.id; });
        LHMS.save(); })()`,
      `LHMS.go('end-of-day')`, `LHMS.rerender()`],
    log: `JSON.stringify((function () {
      var pack = LHMS.auditPack();
      var card = Array.prototype.slice.call(document.querySelectorAll('.card'))
        .filter(function (x) { return /Room money this run posts/.test(x.innerText); })[0];
      return { day: LHMS.bizDay(), unbilled: pack.unbilled.length,
        unbillable: pack.unbillable.length, heldDates: pack.unbillable.map(function (n) { return n.date; }).join('+'),
        redChips: Array.prototype.slice.call(document.querySelectorAll('.chip.red')).map(function (c) { return c.innerText; }).join('|'),
        notice: card && card.querySelector('.notice.error') ? card.querySelector('.notice.error').innerText.replace(/\\s+/g, ' ').slice(0, 230) : 'none',
        cardSub: card ? card.querySelector('.card-sub').innerText : 'missing',
        kpi: __kpi(/Unbilled nights/i),
        firstRows: card ? card.innerText.replace(/\\s+/g, ' ').slice(0, 150) : 'missing',
        roomtax: (LHMS.auditChecks(pack).filter(function (c) { return c.key === 'roomtax'; })[0] || {}).detail };
    })())`
  },
  {
    name: '102-eod-held-confirm', vp: DESKTOP, wait: 1100,
    do: [`(function () { ['arrivals', 'folios', 'roomtax', 'payments', 'currency', 'housekeeping', 'revenue', 'audit']
        .forEach(function (k) { var b = document.querySelector('[data-eod-check][data-key="' + k + '"]'); if (b && !b.checked) b.click(); }); })()`,
      `window.__clearToasts()`,
      `document.querySelector('[data-act="eod-close-open"]').click()`],
    log: `JSON.stringify((function () {
      var m = document.querySelector('#modal-root .modal');
      return { ticked: document.querySelectorAll('[data-eod-check]:checked').length,
        title: m.querySelector('h2').innerText,
        body: m.querySelector('.modal-body').innerText.replace(/\\s+/g, ' ').slice(0, 300),
        label: m.querySelector('[data-confirm="eod-close"]').innerText,
        closedDays: LHMS.db.closedDays.length };
    })())`
  },
  {
    name: '103-eod-held-refused', vp: DESKTOP, wait: 1300,
    do: [`window.__clearToasts()`, `document.querySelector('#modal-root [data-confirm="eod-close"]').click()`],
    log: `JSON.stringify((function () {
      var pack = LHMS.auditPack();
      return { toast: window.__toast(), sealedToday: !!LHMS.closedOn(LHMS.bizDay()),
        dayStill: LHMS.bizDay(), chargesOnHeldFolio: LHMS.db.charges.filter(function (c) {
          return c.reservationId === window.__fxRes && c.department === 'Rooms'; }).length,
        stillHeld: pack.unbillable.length, modalGone: !document.querySelector('#modal-root .modal') };
    })())`
  },
  {
    name: '104-eod-held-posted', vp: DESKTOP, wait: 1500,
    do: [`window.__clearToasts()`,
      `(function () { var held = LHMS.unbillableNights();
        var first = held.length ? held.map(function (n) { return n.date; }).sort()[0] : LHMS.bizDay();
        LHMS.actions.setFxRate({ code: 'USD', perBase: 1575, effective: first, note: 'Back-dated to the first night owed' });
        LHMS.rerender(); })()`,
      `(function () { document.querySelectorAll('[data-eod-check]:checked').length ||
        ['arrivals', 'folios', 'roomtax', 'payments', 'currency', 'housekeeping', 'revenue', 'audit'].forEach(function (k) {
          var b = document.querySelector('[data-eod-check][data-key="' + k + '"]'); if (b && !b.checked) b.click(); }); })()`,
      `document.querySelector('[data-act="eod-close-open"]').click()`,
      `document.querySelector('#modal-root [data-confirm="eod-close"]').click()`],
    log: `JSON.stringify((function () {
      var c = LHMS.db.closedDays[LHMS.db.closedDays.length - 1];
      var ours = LHMS.db.charges.filter(function (x) { return x.reservationId === window.__fxRes && x.department === 'Rooms'; });
      return { toast: window.__toast(), sealed: c.date, rolledTo: LHMS.bizDay(),
        posted: c.posted.length, postedTotal: c.postedTotal,
        nights: ours.map(function (o) { return o.date + ':' + o.currency + '@' + o.fxRate + '=' + o.baseAmount; }).join(' '),
        heldNow: LHMS.auditPack().unbillable.length,
        money: (document.querySelector('.notice.success') || {}).innerText };
    })())`
  },

  /* ---- §10 the Financial Controller: the second pair of hands ---- */
  {
    name: '105-fm-lands-on-the-books', vp: DESKTOP, wait: 1200,
    do: [
      `LHMS.signIn('chiamaka.obi@aureliagrand.com', 'demo1234')`,
      `(function () { var row = LHMS.price.baseRow(LHMS.price.services('room')[0].id);
        window.__fmPrice = row.id; window.__fmWas = row.amount;
        var res = LHMS.actions.setPrice(row.id, { amount: row.amount + 600000 }, 'Festive re-rate on the king');
        window.__fmAsk = res.queued && res.queued.id; })()`,
      `LHMS.switchRole('Finance Manager')`,
      `LHMS.go('financials')`, `LHMS.rerender()`
    ],
    log: `JSON.stringify((function () {
      return { role: LHMS.session.role, name: LHMS.session.name, landing: location.hash,
        signedIn: !!LHMS.session.signedIn,
        heading: (document.querySelector('.page-head .page-title') || {}).innerText,
        canClear: LHMS.canApproveFinancial(), alone: LHMS.movesMoneyAlone(),
        ask: window.__fmAsk ? 'queued' : 'MISSING',
        waiting: LHMS.approvals('Pending').length };
    })())`
  },
  {
    name: '106-fm-queue', vp: DESKTOP, wait: 1100,
    do: [`LHMS.go('fin-settings')`, `(function () { var t = document.getElementById('toast-root'); if (t) t.innerHTML = ''; })()`,
      `LHMS.rerender()`,
      `(function () { var b = document.querySelector('[data-act="apr-approve"]'); if (b) b.scrollIntoView({ block: 'center' }); })()`],
    log: `JSON.stringify((function () {
      var q = LHMS.approvals('Pending');
      return { hash: location.hash, rows: document.querySelectorAll('.list-row').length,
        signButtons: document.querySelectorAll('[data-act="apr-approve"]').length,
        waiting: q.length, mine: q.filter(function (a) { return a.requestedBy === LHMS.session.name; }).length,
        askedBy: Array.from(new Set(q.map(function (a) { return a.requestedBy; }))).join(',') };
    })())`
  },
  {
    name: '107-fm-signed', vp: DESKTOP, wait: 1300,
    do: [`(function () { window.__fmRes = LHMS.actions.decideApproval(window.__fmAsk, true,
        'Checked against the comp set before signing'); LHMS.rerender(); })()`,
      `document.querySelector('[data-act="apr-side"][data-side="decided"]').click()`,
      `(function () { var t = document.querySelector('[data-act="apr-side"]'); if (t) t.closest('.card').scrollIntoView({ block: 'start' }); })()`],
    log: `JSON.stringify((function () {
      var row = LHMS.db.prices.find(function (p) { return p.id === window.__fmPrice; });
      return { ok: window.__fmRes.ok, by: window.__fmRes.approval && window.__fmRes.approval.decidedBy,
        status: window.__fmRes.approval && window.__fmRes.approval.status,
        from: window.__fmWas, to: row.amount,
        history: (LHMS.db.priceHistory[0] || {}).by, stillWaiting: LHMS.approvals('Pending').length };
    })())`
  },
  {
    name: '108-fm-rate-waits', vp: DESKTOP, wait: 1200,
    do: [`(function () { window.__fmRate = LHMS.actions.setFxRate({ code: 'USD', perBase: 1600,
        note: 'Controller fixing for the board' }); })()`, `LHMS.rerender()`,
      `(function () { var h = Array.prototype.slice.call(document.querySelectorAll('.card-title'))
          .find(function (e) { return /Exchange rates/.test(e.textContent); });
        if (h) h.closest('.card').scrollIntoView({ block: 'start' }); })()`],
    log: `JSON.stringify({ queued: !!window.__fmRate.queued, kind: window.__fmRate.queued && window.__fmRate.queued.kind,
      askedBy: window.__fmRate.queued && window.__fmRate.queued.requestedBy,
      filed: LHMS.db.fxRates.some(function (r) { return r.perBase === 1600; }) })`
  },
  {
    name: '109-fm-no-price-desk', vp: DESKTOP, wait: 1000,
    do: [`LHMS.go('prices')`, `LHMS.rerender()`],
    log: `JSON.stringify({ bouncedTo: location.hash,
      heading: (document.querySelector('.page-head .page-title') || {}).innerText,
      absentFromNav: ['prices', 'taxes', 'revenue', 'setup', 'staff', 'end-of-day'].filter(function (k) {
        return !document.querySelector('a[href="#/' + k + '"]'); }).join(','),
      can: { price: LHMS.can('configure_prices'), rate: LHMS.can('manage_rates'),
        sell: LHMS.can('post_charges'), seal: LHMS.can('night_audit'), sign: LHMS.can('approve_financial_changes') },
      navHasPrices: !!document.querySelector('a[href="#/prices"]') })`
  },
  {
    name: '110-matrix-locked-column', vp: DESKTOP, wait: 1300,
    do: [`LHMS.signIn('ifeoma.okafor@aureliagrand.com', 'aurelia2026')`, `LHMS.go('staff')`, `LHMS.rerender()`,
      `(function () { var h = Array.prototype.slice.call(document.querySelectorAll('.card-title'))
          .find(function (e) { return /Permission matrix/.test(e.textContent); });
        if (h) h.closest('.card').scrollIntoView({ block: 'start' }); })()`],
    log: `JSON.stringify((function () {
      var f = LHMS.defaultPermissions()['Finance Manager'];
      var held = Object.keys(f).filter(function (k) { return f[k]; }).sort();
      var locked = document.querySelectorAll('[data-perm][data-role="Finance Manager"]').length;
      return { held: held.join(','), editableCells: locked,
        askLocked: LHMS.actions.setPermission('Finance Manager', 'record_expenses', true).ok === false };
    })())`
  },
  {
    // A guard, not a screen: every page each role can reach is opened once and read
    // back for the error card the app draws when a renderer throws, and for an
    // object that was concatenated into a sentence instead of one of its figures —
    // which no renderer throws for, and no test of the data layer would ever see.
    name: '111-every-reachable-screen-renders', vp: DESKTOP, wait: 400,
    do: [`LHMS.signIn('ifeoma.okafor@aureliagrand.com', 'aurelia2026')`, `LHMS.go('financials')`, `LHMS.rerender()`],
    log: `JSON.stringify((function () {
      // A route the role cannot see bounces to their landing, and the bounce is a
      // second render, so each visit draws twice before the page is read.
      function show(p) { LHMS.go(p); LHMS.rerender(); LHMS.rerender(); }
      var out = {};
      ['Manager', 'Front Desk', 'Housekeeping', 'Revenue', 'Finance Manager', 'Auditor'].forEach(function (role) {
        LHMS.switchRole(role); show('today');
        var keys = Array.from(new Set(Array.from(document.querySelectorAll('.sidebar nav a[href^="#/"]'))
          .map(function (a) { return a.getAttribute('href').slice(2).split('/')[0]; })));
        var broken = [], leaked = [];
        keys.forEach(function (k) { show(k);
          var t = document.body.innerText;
          if (/could not render|Something went wrong/i.test(t)) broken.push(k);
          else if (t.indexOf('[object Object]') !== -1) leaked.push(k); });
        out[role] = keys.length + (broken.length ? ' · BROKEN ' + broken.join(',') : '') +
          (leaked.length ? ' · LEAKED ' + leaked.join(',') : '');
      });
      LHMS.switchRole('Manager'); show('financials');
      return out;
    })())`
  },
  {
    name: '112-plan-editor-asks-why', vp: DESKTOP, wait: 1000,
    do: [`(function () { window.__toast = function () { var t = document.querySelectorAll('.toast'); return t.length ? t[t.length - 1].innerText.trim() : 'none'; }; })()`,
      `LHMS.signIn('ifeoma.okafor@aureliagrand.com', 'aurelia2026')`, `LHMS.go('revenue')`, `LHMS.rerender()`,
      `document.querySelector('[data-act="edit-plan"][data-plan="flex"]').click()`],
    log: `JSON.stringify((function () {
      var m = document.querySelector('#modal-root .modal');
      var p = LHMS.get.ratePlan('flex');
      return { title: m.querySelector('h2').innerText,
        fields: Array.prototype.slice.call(m.querySelectorAll('[name]')).map(function (e) { return e.name; }).join(','),
        on: p.modifier + ' / ' + p.depositPct + '%',
        foot: Array.prototype.slice.call(m.querySelectorAll('.modal-foot .btn')).map(function (b) { return b.innerText.trim(); }).join(' | ') };
    })())`
  },
  {
    // The two figures are retyped and the reason left out: the form's own validity
    // check holds the modal open, so the plan keeps the terms it had.
    name: '113-plan-save-blocked-without-reason', vp: DESKTOP, wait: 700,
    do: [`(function () { var f = document.querySelector('#modal-root [data-form="plan"]');
        f.querySelector('[name="modifier"]').value = '0.9';
        f.querySelector('[name="depositPct"]').value = '30'; })()`,
      `document.querySelector('[data-act="save-plan"]').click()`],
    log: `JSON.stringify((function () {
      var r = document.querySelector('#modal-root [data-form="plan"] [name="reason"]');
      var p = LHMS.get.ratePlan('flex');
      return { stillOpen: !!document.querySelector('#modal-root [data-form="plan"]'),
        reasonMissing: r.validity.valueMissing, plan: p.modifier + ' / ' + p.depositPct + '%',
        toast: window.__toast() };
    })())`
  },
  {
    name: '114-plan-saved-and-signed', vp: DESKTOP, wait: 1100,
    do: [`(function () { var f = document.querySelector('#modal-root [data-form="plan"]');
        f.querySelector('[name="reason"]').value = 'Shoulder-season push agreed on the Tuesday revenue call'; })()`,
      `document.querySelector('[data-act="save-plan"]').click()`],
    log: `JSON.stringify((function () {
      var p = LHMS.get.ratePlan('flex');
      var row = Array.prototype.slice.call(document.querySelectorAll('table.data tbody tr'))
        .find(function (tr) { return /Flexible Rate/.test(tr.innerText); });
      return { toast: window.__toast(), closed: !document.querySelector('#modal-root [data-form="plan"]'),
        plan: p.modifier + ' / ' + p.depositPct + '%',
        row: row ? row.innerText.replace(/\\s+/g, ' ').slice(0, 120) : 'no row',
        trail: LHMS.db.activity[0].detail,
        // The same two nights the counter would now quote, off the edited plan.
        quote: (function () { var U = LHMS.util; var ci = U.today();
          var q = LHMS.price.stay('dk', 'flex', ci, U.addDays(ci, 2), 2);
          return q.roomTotal + ' / deposit ' + q.deposit; })() };
    })())`
  },
  {
    // The shoot profile keeps whatever the last step wrote, so the edited plan is
    // handed back before the next capture run quotes a stale 90% rate as the demo.
    name: '115-plan-editor-restores-the-seeded-terms', vp: DESKTOP, wait: 1000,
    do: [`document.querySelector('[data-act="edit-plan"][data-plan="flex"]').click()`,
      `(function () { var f = document.querySelector('#modal-root [data-form="plan"]');
        f.querySelector('[name="modifier"]').value = '1';
        f.querySelector('[name="depositPct"]').value = '25';
        f.querySelector('[name="reason"]').value = 'Shoulder-season push closed; the flexible rate is back on the list'; })()`,
      `document.querySelector('[data-act="save-plan"]').click()`],
    log: `JSON.stringify((function () {
      var p = LHMS.get.ratePlan('flex');
      var U = LHMS.util; var ci = U.today();
      var q = LHMS.price.stay('dk', 'flex', ci, U.addDays(ci, 2), 2);
      return { toast: window.__toast(), closed: !document.querySelector('#modal-root [data-form="plan"]'),
        plan: p.modifier + ' / ' + p.depositPct + '%',
        trail: LHMS.db.activity[0].detail,
        quote: q.roomTotal + ' / deposit ' + q.deposit };
    })())`
  },
  {
    // Hotel setup, Policies tab: the form a manager edits the commercial terms
    // with, and the sentence under the money of account that says why it is
    // locked once the books hold money.
    name: '116-setup-opens-on-the-policies-form', vp: DESKTOP, wait: 1000,
    do: [`(function () { window.__toast = function () { var t = document.querySelectorAll('.toast'); return t.length ? t[t.length - 1].innerText.trim() : 'none'; }; })()`,
      `LHMS.signIn('ifeoma.okafor@aureliagrand.com', 'aurelia2026')`, `LHMS.go('setup')`, `LHMS.rerender()`,
      `document.querySelector('[data-act="setup-tab"][data-tab="policies"]').click()`],
    log: `JSON.stringify((function () {
      var f = document.querySelector('form[data-form="policy"]');
      var hint = Array.prototype.slice.call(document.querySelectorAll('.tiny.muted'))
        .map(function (e) { return e.innerText.trim(); })
        .find(function (t) { return /money/.test(t); }) || 'none';
      var s = LHMS.get.settings(LHMS.get.property().id);
      return { tabs: Array.prototype.slice.call(document.querySelectorAll('.tabs .tab')).map(function (b) { return b.innerText.trim(); }).join('|'),
        fields: Array.prototype.slice.call(f.querySelectorAll('[name]')).map(function (e) { return e.name; }).join(','),
        on: s.depositPct + ' / ' + s.checkInTime + ' / ' + s.overbooking + ' / ' + s.currency,
        held: LHMS.moneyRecordsOnFile(LHMS.get.property().id),
        hint: hint.slice(0, 96) };
    })())`
  },
  {
    name: '117-setup-policy-saved-and-signed', vp: DESKTOP, wait: 1100,
    do: [`(function () { var f = document.querySelector('form[data-form="policy"]');
        f.querySelector('[name="depositPct"]').value = '30';
        f.querySelector('[name="overbooking"]').value = '0'; })()`,
      `document.querySelector('[data-act="save-policy"]').click()`],
    log: `JSON.stringify((function () {
      var s = LHMS.get.settings(LHMS.get.property().id);
      return { toast: window.__toast(), on: s.depositPct + ' / ' + s.overbooking,
        trail: LHMS.db.activity[0].detail };
    })())`
  },
  {
    name: '118-setup-integration-disconnected', vp: DESKTOP, wait: 1100,
    do: [`document.querySelector('[data-act="setup-tab"][data-tab="integrations"]').click()`,
      `document.querySelector('[data-act="toggle-integration"][data-key="crm"]').click()`],
    log: `JSON.stringify((function () {
      var card = Array.prototype.slice.call(document.querySelectorAll('.panel'))
        .find(function (p) { return /Guest CRM/.test(p.innerText); });
      var chip = Array.prototype.slice.call(document.querySelectorAll('.page-head .chip, .chip'))
        .map(function (c) { return c.innerText.trim(); })
        .find(function (t) { return /integrations live/.test(t); });
      var a = LHMS.db.activity.filter(function (x) { return x.entity === 'integration'; });
      return { toast: window.__toast(), card: card.innerText.replace(/\\s+/g, ' ').slice(0, 70),
        live: chip, crm: LHMS.get.settings(LHMS.get.property().id).integrations.crm,
        lines: a.slice(0, 2).map(function (x) { return x.action + ' · ' + x.detail; }).join(' | ') };
    })())`
  },
  {
    // Both halves of the page are put back the way the seed files them, so the
    // persisted profile does not hand a 30% deposit to the next capture run.
    name: '119-setup-restores-the-seeded-book', vp: DESKTOP, wait: 1100,
    do: [`document.querySelector('[data-act="toggle-integration"][data-key="crm"]').click()`,
      `document.querySelector('[data-act="setup-tab"][data-tab="policies"]').click()`,
      `(function () { var f = document.querySelector('form[data-form="policy"]');
        f.querySelector('[name="depositPct"]').value = '25';
        f.querySelector('[name="overbooking"]').value = '2'; })()`,
      `document.querySelector('[data-act="save-policy"]').click()`],
    log: `JSON.stringify((function () {
      var s = LHMS.get.settings(LHMS.get.property().id);
      return { toast: window.__toast(), on: s.depositPct + ' / ' + s.overbooking,
        crm: s.integrations.crm, trail: LHMS.db.activity[0].detail };
    })())`
  },
  {
    // The tab that replaced the old demo controls: it reports what the
    // workspace holds and where it lives, and offers no way to wipe it.
    name: '119b-setup-system-tab', vp: DESKTOP, wait: 1000,
    do: [`document.querySelector('[data-act="setup-tab"][data-tab="system"]').click()`],
    log: `JSON.stringify((function () {
      var tabs = Array.prototype.slice.call(document.querySelectorAll('.tabs .tab')).map(function (b) { return b.innerText.trim(); });
      var heads = Array.prototype.slice.call(document.querySelectorAll('.panel h3, .panel .panel-title'))
        .map(function (h) { return h.innerText.trim(); }).slice(0, 4);
      return { toast: 'none', tabs: tabs.join('|'), heads: heads.join('|'),
        rows: document.querySelectorAll('table tbody tr').length,
        hasReset: !!document.querySelector('[data-act="reset-demo-open"]') };
    })())`
  },
  {
    // The brand tab opens on the seeded lock-up: the group name, no artwork,
    // and the house palette still in charge.
    name: '120-brand-tab', vp: DESKTOP, wait: 1000,
    do: [`LHMS.signIn('ifeoma.okafor@aureliagrand.com', 'aurelia2026')`,
      `LHMS.switchProperty('agm')`,
      `LHMS.go('setup')`, `LHMS.rerender()`,
      `document.querySelector('[data-act="setup-tab"][data-tab="brand"]').click()`],
    log: `JSON.stringify((function () { var b = LHMS.get.branding('agm');
      return { name: b.brandName, tagline: b.tagline, logo: !!b.logo,
        images: b.images.length, palette: b.palette, useColors: b.useColors }; })())`
  },
  {
    // Upload a logo and a photograph the way the file picker would, then read
    // the palette off the logo's own pixels and apply it across the system.
    name: '121-brand-uploaded', vp: DESKTOP, wait: 1300,
    do: [`(function () {
      var logo = document.createElement('canvas'); logo.width = logo.height = 320;
      var g = logo.getContext('2d');
      g.fillStyle = '#0b2e4f'; g.fillRect(0, 0, 320, 320);
      g.fillStyle = '#c9a227'; g.beginPath(); g.arc(160, 160, 108, 0, 6.2832); g.fill();
      g.fillStyle = '#0b2e4f'; g.font = 'bold 150px Georgia'; g.textAlign = 'center';
      g.textBaseline = 'middle'; g.fillText('A', 160, 176);
      var photo = document.createElement('canvas'); photo.width = 900; photo.height = 560;
      var p = photo.getContext('2d');
      var sky = p.createLinearGradient(0, 0, 0, 560);
      sky.addColorStop(0, '#2f5d7c'); sky.addColorStop(0.55, '#c9a27a'); sky.addColorStop(1, '#e8dcc4');
      p.fillStyle = sky; p.fillRect(0, 0, 900, 560);
      p.fillStyle = '#123d5c'; p.fillRect(0, 380, 900, 180);
      p.fillStyle = '#f3e6c8'; p.fillRect(60, 300, 780, 12);
      var src = logo.toDataURL('image/png');
      var shot = photo.toDataURL('image/jpeg', 0.72);
      var px = g.getImageData(0, 0, 320, 320);
      LHMS.actions.saveBranding('agm', {
        logo: src, images: [{ src: shot, name: 'Lagoon at dusk' }],
        palette: LHMS.brand.paletteFromPixels(px.data), useColors: true
      });
      LHMS.rerender();
      document.querySelector('[data-act="setup-tab"][data-tab="brand"]').click();
    })()`],
    log: `JSON.stringify((function () { var b = LHMS.get.branding('agm');
      var st = getComputedStyle(document.documentElement);
      return { images: b.images.length, logo: !!b.logo,
        palette: b.palette, navy: st.getPropertyValue('--navy').trim(),
        gold: st.getPropertyValue('--gold').trim(), trail: LHMS.db.activity[0].detail }; })())`
  },
  {
    // The gallery and the "where it appears" map, below the identity card.
    name: '121b-brand-gallery', vp: DESKTOP, wait: 800,
    do: [`window.scrollTo(0, 720)`],
    log: `JSON.stringify((function () { var b = LHMS.get.branding('agm');
      return { tiles: document.querySelectorAll('.brand-tile').length,
        cover: !!document.querySelector('.brand-cover-tag'),
        swatches: document.querySelectorAll('.brand-swatches .swatch').length }; })())`
  },
  {
    // Signing out leaves the property in session, so the landing page the next
    // guest sees is the hotel's own photograph, logo, name and colours.
    name: '122-brand-landing', vp: DESKTOP, wait: 1100,
    do: [`LHMS.signOut()`, `LHMS.rerender()`],
    log: `JSON.stringify((function () { var b = LHMS.get.branding('agm');
      var img = document.querySelector('.signin-visual .brand-mark img');
      var slide = document.querySelector('.signin-slide');
      return { images: b.images.length, imageSrc: b.images[0] && b.images[0].src.slice(0, 24),
        slides: document.querySelectorAll('.signin-slide').length,
        slideSrc: slide && slide.getAttribute('src').slice(0, 24),
        logo: img ? { complete: img.complete, w: img.naturalWidth, src: img.getAttribute('src').slice(0, 24) } : null,
        name: (document.querySelector('.signin-visual .brand-name') || {}).innerText,
        kicker: (document.querySelector('.signin-visual .brand-kicker') || {}).innerText,
        navy: getComputedStyle(document.documentElement).getPropertyValue('--navy').trim() }; })())`
  },
  {
    // The point of the module: a logo in a colour the house has never worn must
    // dress the whole desk. Green ink, terracotta accent — and the board behind
    // the setup page repaints: wash, cards, rules and sidebar.
    name: '123-brand-repaints-the-desk', vp: DESKTOP, wait: 1200,
    do: [`LHMS.signIn('ifeoma.okafor@aureliagrand.com', 'aurelia2026')`,
      `LHMS.switchProperty('agm')`,
      `LHMS.actions.saveBranding('agm', { palette: ['#0e3b2a', '#b4552f'], useColors: true })`,
      `LHMS.go('today')`, `LHMS.rerender()`],
    log: `JSON.stringify((function () {
      var st = getComputedStyle(document.documentElement);
      var pick = function (k) { return st.getPropertyValue(k).trim(); };
      var side = document.querySelector('.sidebar');
      return { navy: pick('--navy'), gold: pick('--gold'), bg: pick('--bg'),
        card: pick('--card'), line: pick('--line'),
        bodyBg: getComputedStyle(document.body).backgroundColor,
        sidebar: side ? getComputedStyle(side).backgroundImage.slice(0, 70) : null }; })())`
  },
  {
    // …and the charts draw in it too, because they ask for their colours when
    // they render rather than remembering the palette the file loaded with.
    name: '123b-brand-repaints-charts', vp: DESKTOP, wait: 1100,
    do: [`LHMS.signIn('ifeoma.okafor@aureliagrand.com', 'aurelia2026')`,
      `LHMS.switchProperty('agm')`,
      `LHMS.actions.saveBranding('agm', { palette: ['#0e3b2a', '#b4552f'], useColors: true })`,
      `LHMS.go('financials')`, `LHMS.rerender()`,
      // The range is page state and the earlier sweep leaves it on Today, which
      // draws an empty state instead of a chart.
      `document.querySelector('[data-act="fin-range"][data-days="30"]').click()`],
    log: `JSON.stringify((function () {
      var line = document.querySelector('.chart .line-main');
      var key = document.querySelector('.chart-legend i');
      var donut = document.querySelector('.donut');
      return { lineStroke: line && getComputedStyle(line).stroke,
        legendKey: key && getComputedStyle(key).backgroundColor,
        donut: ((donut && donut.getAttribute('style')) || '').slice(0, 90) }; })())`
  },
  {
    // The guest phone is part of the same desk: its chrome, cards and dark
    // panels take the logo's colours too.
    name: '123c-brand-repaints-the-portal', vp: PHONE, wait: 1200,
    do: [`LHMS.signOut()`, `LHMS.rerender()`,
      `document.querySelector('[data-act="guest-signin"]').click()`],
    log: `JSON.stringify((function () {
      var top = document.querySelector('.phone-top');
      var card = document.querySelector('.g-card.dark') || document.querySelector('.g-card');
      var stage = document.querySelector('.guest-stage');
      return { top: top && getComputedStyle(top).backgroundImage.slice(0, 70),
        card: card && getComputedStyle(card).backgroundColor,
        stage: stage && getComputedStyle(stage).backgroundColor }; })())`
  },
  {
    // The counterpart of 123b: with the logo palette cleared the same chart
    // machinery must draw in the house navy and gold, not remember the green.
    name: '123d-brand-house-charts', vp: DESKTOP, wait: 1100,
    do: [`LHMS.signIn('ifeoma.okafor@aureliagrand.com', 'aurelia2026')`,
      `LHMS.switchProperty('agm')`,
      `LHMS.actions.saveBranding('agm', { palette: null, useColors: true })`,
      `LHMS.go('financials')`, `LHMS.rerender()`,
      `document.querySelector('[data-act="fin-range"][data-days="30"]').click()`],
    log: `JSON.stringify((function () {
      var st = getComputedStyle(document.documentElement);
      var line = document.querySelector('.chart .line-main');
      var key = document.querySelector('.chart-legend i');
      var donut = document.querySelector('.donut');
      return { navy: st.getPropertyValue('--navy').trim(), gold: st.getPropertyValue('--gold').trim(),
        lineStroke: line && getComputedStyle(line).stroke,
        legendKey: key && getComputedStyle(key).backgroundColor,
        donut: ((donut && donut.getAttribute('style')) || '').slice(0, 90) }; })())`
  },
  {
    // The waitlist board: one live release with its hold clock, and the queue
    // behind it. The panel only exists when the house owes someone a room.
    name: '124-waitlist-board', vp: DESKTOP, wait: 1000,
    do: [`LHMS.signIn('ifeoma.okafor@aureliagrand.com', 'aurelia2026')`,
      `LHMS.switchProperty('agm')`,
      `LHMS.go('reservations')`, `LHMS.rerender()`],
    log: `JSON.stringify((function () {
      var accept = document.querySelector('[data-act="waitlist-accept"]');
      var panel = accept && accept.closest('section.card');
      return { offers: LHMS.waitlist.active('agm').length, queue: LHMS.waitlist.queue('agm').length,
        accept: Boolean(accept), release: Boolean(document.querySelector('[data-act="waitlist-release"]')),
        rows: panel ? panel.querySelectorAll('.list-row').length : 0,
        title: panel && panel.querySelector('.card-title').innerText.trim(),
        hold: panel && (panel.innerText.match(/hold until [0-9:]+/) || [''])[0] }; })())`
  },
  {
    // The held stay's own page: the release is an offer card naming the room and
    // the hold clock, and the rate is a quote rather than a folio.
    name: '124a-waitlist-booking', vp: DESKTOP, wait: 1000,
    do: [`LHMS.signIn('ifeoma.okafor@aureliagrand.com', 'aurelia2026')`,
      `LHMS.switchProperty('agm')`,
      `LHMS.go('booking/' + LHMS.waitlist.queue('agm')[0].id)`, `LHMS.rerender()`],
    log: `JSON.stringify((function () {
      var r = LHMS.waitlist.queue('agm')[0];
      return { status: r && r.status, room: r && r.roomId,
        offer: Boolean(document.querySelector('[data-act="waitlist-accept"]')),
        quote: document.body.innerText.indexOf('Nothing is billed until a room is released') !== -1,
        card: (document.querySelector('.card-title') || {}).innerText }; })())`
  },
  {
    // Taking the release up confirms the stay in one step: the room is now the
    // stay's own and the folio carries the nights that were quoted on the board.
    name: '124b-waitlist-accepted', vp: DESKTOP, wait: 1300,
    do: [`LHMS.signIn('ifeoma.okafor@aureliagrand.com', 'aurelia2026')`,
      `LHMS.switchProperty('agm')`,
      `LHMS.go('reservations')`, `LHMS.rerender()`,
      `document.querySelector('[data-act="waitlist-accept"]').click()`],
    log: `JSON.stringify((function () {
      var r = LHMS.db.reservations.filter(function (x) { return x.waitlistConfirmedAt; })[0];
      return { confirmed: Boolean(r), status: r && r.status, room: r && r.roomId,
        folio: r ? LHMS.folio(r.id).total : 0,
        heading: (document.querySelector('.page-head h1') || {}).innerText }; })())`
  },
  {
    // Proposal captures: four boards the operational sweep visits but never
    // frames. They sign in themselves so a filtered run starts from the lock-up.
    name: 'P1-room-map', vp: DESKTOP, wait: 1000,
    do: [`LHMS.signIn('ifeoma.okafor@aureliagrand.com', 'aurelia2026')`,
      `LHMS.switchProperty('agm')`, `LHMS.go('room-map')`, `LHMS.rerender()`],
    log: `JSON.stringify({ heading: (document.querySelector('.page-head h1') || {}).innerText,
      tiles: document.querySelectorAll('.room-tile, [data-act="room-open"]').length })`
  },
  {
    name: 'P2-housekeeping', vp: DESKTOP, wait: 1000,
    do: [`LHMS.signIn('ifeoma.okafor@aureliagrand.com', 'aurelia2026')`,
      `LHMS.go('housekeeping')`, `LHMS.rerender()`],
    log: `JSON.stringify({ heading: (document.querySelector('.page-head h1') || {}).innerText,
      columns: document.querySelectorAll('.hk-col, [data-act="task-done"]').length })`
  },
  {
    name: 'P3-staff-permissions', vp: DESKTOP, wait: 1000,
    do: [`LHMS.signIn('ifeoma.okafor@aureliagrand.com', 'aurelia2026')`,
      `LHMS.go('staff')`, `LHMS.rerender()`],
    log: `JSON.stringify({ heading: (document.querySelector('.page-head h1') || {}).innerText,
      rows: document.querySelectorAll('table.data tbody tr').length })`
  },
  {
    name: 'P4-document-register', vp: DESKTOP, wait: 1000,
    do: [`LHMS.signIn('ifeoma.okafor@aureliagrand.com', 'aurelia2026')`,
      `LHMS.go('documents')`, `LHMS.rerender()`],
    log: `JSON.stringify({ heading: (document.querySelector('.page-head h1') || {}).innerText,
      rows: document.querySelectorAll('table.data tbody tr').length })`
  },
  {
    // The sweep's hall board can inherit a toast from the booking it just made;
    // the proposal needs the board alone, so this pause outlasts the toast.
    name: 'P5-hall-bookings', vp: DESKTOP, wait: 5000,
    do: [`LHMS.signIn('ifeoma.okafor@aureliagrand.com', 'aurelia2026')`,
      `LHMS.switchProperty('agm')`, `LHMS.go('events/' + LHMS.db.events[0].date)`, `LHMS.rerender()`],
    log: `JSON.stringify({ heading: (document.querySelector('.page-head h1') || {}).innerText,
      halls: LHMS.halls().length, toast: !!document.querySelector('.toast') })`
  }
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// HMS_ONLY=68 skips to a numbered band of steps when only those need rechecking.
// The steps that sign in or switch a role do it themselves, so a filtered run
// still starts from a clean page and a clean seeded database.
const ONLY = process.env.HMS_ONLY ? new RegExp(process.env.HMS_ONLY) : null;

async function waitForTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch (e) { /* chrome is still starting */ }
    await sleep(250);
  }
  throw new Error('Chrome did not expose a DevTools endpoint on port ' + PORT);
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error('DevTools websocket failed'));
  });
}

function session(ws, events) {
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method && events[msg.method]) {
      events[msg.method](msg.params);
    }
  };
  return (method, params) => new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params: params || {} }));
  });
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
    `--user-data-dir=${PROFILE}`, '--disable-gpu', '--no-first-run',
    '--no-default-browser-check', '--hide-scrollbars', 'about:blank'
  ], { stdio: 'ignore' });

  const token = `shoot${Date.now()}`;
  try {
    const ws = await connect(await waitForTarget());
    const problems = [];
    const events = {
      'Runtime.exceptionThrown': (p) => problems.push(p.exceptionDetails.exception
        ? String(p.exceptionDetails.exception.description || p.exceptionDetails.exception.value).split('\n')[0]
        : p.exceptionDetails.text),
      'Log.entryAdded': (p) => { if (p.entry.level === 'error') problems.push(p.entry.text); },
      'Runtime.consoleAPICalled': (p) => {
        if (p.type === 'error' || p.type === 'warning') {
          problems.push(p.args.map((a) => a.value === undefined ? a.description : a.value).join(' '));
        }
      }
    };
    const send = session(ws, events);
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Log.enable');
    await send('Page.navigate', { url: `${BASE}?h=${token}#/login` });
    // The app is 17 scripts deep and the last one defines LHMS.go, so a fixed
    // pause loses the race whenever the server is cold. Wait for the boot instead.
    for (let i = 0; i < 60; i++) {
      const ready = await send('Runtime.evaluate', {
        expression: '!!(window.LHMS && typeof LHMS.go === "function" && LHMS.rerender)', returnByValue: true
      });
      if (ready.result && ready.result.value) break;
      await sleep(250);
    }
    await sleep(600);

    let width = 0;
    let height = 0;
    for (const step of STEPS) {
      if (ONLY && !ONLY.test(step.name)) continue;
      if (step.vp[0] !== width || step.vp[1] !== height) {
        width = step.vp[0];
        height = step.vp[1];
        await send('Emulation.setDeviceMetricsOverride', {
          width, height, deviceScaleFactor: 2, mobile: width < 700
        });
      }
      for (const expr of step.do || []) {
        const out = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
        if (out.exceptionDetails) {
          throw new Error(`${step.name}: ${out.exceptionDetails.text} ${(out.exceptionDetails.exception || {}).description || ''}`);
        }
      }
      await sleep(step.wait || 300);
      if (step.log) {
        const out = await send('Runtime.evaluate', { expression: step.log, returnByValue: true });
        console.log(`  ${step.name} · ${JSON.stringify(out.result && out.result.value)}`);
      }
      const file = path.join(OUT, step.name + '.png');
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'), 'base64');
      console.log(`${file} (${width}x${height})`);
    }
    ws.close();
    if (problems.length) {
      console.log('\nconsole: ' + problems.length + ' problem(s)');
      problems.slice(0, 10).forEach((p) => console.log('  ! ' + p));
      process.exitCode = 1;
    } else {
      console.log('\nconsole: clean');
    }
  } finally {
    chrome.kill();
  }
}

main().catch((err) => { console.error('FAILED: ' + err.message); process.exitCode = 1; });
