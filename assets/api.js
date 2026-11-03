/* ============================================================
   Aurelia Grand — REST client

   One named door per endpoint the Express API mounts, so a caller never
   hand-writes a URL.

   It is a client, not a run mode. Every page still reads and writes the
   engine in store.js, which is where the workspace's figures are assembled and
   what the API is a port of. Nothing here patches LHMS.signIn or any action:
   the login form reads `result.ok` synchronously (assets/app.js), so a
   Promise returned in its place is a silent failure, not an upgrade. Moving
   a screen onto the network is that screen's own change, with its figures
   proved equal first.

   server/tests/api-client.test.js reads the table below and refuses drift
   in either direction — a door with no route behind it, or a ported route
   nobody can reach from the client.

   LHMS.api exists only when an API base is configured, before this file
   loads:  <meta name="api-base" content="http://localhost:3001" />
   or  window.LHMS_API_BASE = "http://localhost:3001".
   ============================================================ */
(function () {
  var LHMS = window.LHMS;

  /* ── resolve the API base URL ──────────────────────────────── */
  var base = (function () {
    var meta = document.querySelector('meta[name="api-base"]');
    if (meta && meta.content) return meta.content.replace(/\/$/, "");
    return window.LHMS_API_BASE || null;
  })();

  if (!base) {
    console.info("[LHMS] No api-base set: the app runs on the local engine in store.js.");
    return;
  }

  /* ── token storage ─────────────────────────────────────────── */
  var TOKEN_KEY = "aurelia.lhms.token";
  function getToken()   { return sessionStorage.getItem(TOKEN_KEY); }
  function setToken(t)  { sessionStorage.setItem(TOKEN_KEY, t); }
  function clearToken() { sessionStorage.removeItem(TOKEN_KEY); }

  /* ── core fetch helper ──────────────────────────────────────── */
  function req(method, path, body, query) {
    var headers = { "Content-Type": "application/json" };
    var token = getToken();
    if (token) headers["Authorization"] = "Bearer " + token;
    if (query && Object.keys(query).length) {
      path += (path.indexOf("?") === -1 ? "?" : "&") + new URLSearchParams(query).toString();
    }
    return fetch(base + path, {
      method:  method,
      headers: headers,
      body:    body !== undefined ? JSON.stringify(body) : undefined
    }).then(function (res) {
      if (res.status === 204) return null;
      return res.json().then(function (data) {
        if (!res.ok) {
          throw Object.assign(new Error(data.error || "Request failed."),
            { status: res.status, data: data });
        }
        return data;
      });
    });
  }

  /* ── the surface ───────────────────────────────────────────────
     [method, path]. A {placeholder} is filled by the next positional
     argument; after those, a GET or DELETE takes its query object and a
     POST or PATCH takes its body. */
  var DOORS = {
    /* health */
    health:               ["GET",    "/health"],

    /* sign-in */
    login:                ["POST",   "/api/auth/login"],
    guestSignIn:          ["POST",   "/api/auth/guest"],
    me:                   ["GET",    "/api/auth/me"],
    logout:               ["POST",   "/api/auth/logout"],

    /* properties, hotel policies and the integration register */
    properties:           ["GET",    "/api/properties"],
    property:             ["GET",    "/api/properties/{propertyId}"],
    savePropertyProfile:  ["PATCH",  "/api/properties/{propertyId}"],
    hotelSettings:        ["GET",    "/api/properties/{propertyId}/settings"],
    saveHotelSettings:    ["PATCH",  "/api/properties/{propertyId}/settings"],
    saveBranding:         ["PATCH",  "/api/properties/{propertyId}/branding"],
    toggleIntegration:    ["POST",   "/api/properties/{propertyId}/integrations/{key}/toggle"],

    /* the guest portal — the in-house stay, never somebody else's */
    guestStay:            ["GET",    "/api/guest/stay"],
    guestFolio:           ["GET",    "/api/guest/folio"],
    guestRequests:        ["GET",    "/api/guest/requests"],
    raiseRequest:         ["POST",   "/api/guest/requests"],
    placeOrder:           ["POST",   "/api/guest/orders"],
    bookStay:             ["POST",   "/api/guest/bookings"],
    guestCheckIn:         ["POST",   "/api/guest/check-in"],
    guestCheckOut:        ["POST",   "/api/guest/check-out"],
    settleBalance:        ["POST",   "/api/guest/payments"],
    redeemPoints:         ["POST",   "/api/guest/redeem"],
    savePreferences:      ["PATCH",  "/api/guest/preferences"],

    /* guest register */
    guests:               ["GET",    "/api/guests"],
    guest:                ["GET",    "/api/guests/{guestId}"],
    createGuest:          ["POST",   "/api/guests"],
    updateGuest:          ["PATCH",  "/api/guests/{guestId}"],
    addGuestNote:         ["POST",   "/api/guests/{guestId}/notes"],

    /* reservations and folios */
    reservations:         ["GET",    "/api/reservations"],
    reservation:          ["GET",    "/api/reservations/{reservationId}"],
    folio:                ["GET",    "/api/reservations/{reservationId}/folio"],
    createReservation:    ["POST",   "/api/reservations"],
    checkIn:              ["POST",   "/api/reservations/{reservationId}/check-in"],
    checkOut:             ["POST",   "/api/reservations/{reservationId}/check-out"],
    cancelReservation:    ["POST",   "/api/reservations/{reservationId}/cancel"],
    postCharge:           ["POST",   "/api/reservations/{reservationId}/charges"],
    voidCharge:           ["POST",   "/api/reservations/{reservationId}/charges/{chargeId}/void"],
    takePayment:          ["POST",   "/api/reservations/{reservationId}/payments"],
    redeemOnFolio:        ["POST",   "/api/reservations/{reservationId}/redeem"],

    /* the waitlist — offers on hold and the queue behind them */
    waitlist:             ["GET",    "/api/waitlist"],
    releaseWaitlist:      ["POST",   "/api/waitlist/release"],
    acceptWaitlistOffer:  ["POST",   "/api/waitlist/{offerId}/accept"],
    declineWaitlistOffer: ["POST",   "/api/waitlist/{offerId}/decline"],

    /* rooms */
    rooms:                ["GET",    "/api/rooms"],
    roomTypes:            ["GET",    "/api/rooms/types"],
    roomAvailability:     ["GET",    "/api/rooms/types/{typeId}/availability"],
    updateRoomStatus:     ["PATCH",  "/api/rooms/{roomId}/status"],

    /* tasks — the one that releases a room is completeTask */
    tasks:                ["GET",    "/api/tasks"],
    createTask:           ["POST",   "/api/tasks"],
    updateTask:           ["PATCH",  "/api/tasks/{taskId}"],
    completeTask:         ["POST",   "/api/tasks/{taskId}/complete"],

    /* staff and the permission matrix */
    staff:                ["GET",    "/api/staff"],
    permissions:          ["GET",    "/api/staff/permissions"],
    createStaff:          ["POST",   "/api/staff"],
    updateStaff:          ["PATCH",  "/api/staff/{staffId}"],
    setPermission:        ["PATCH",  "/api/staff/permissions"],

    /* dashboard metrics */
    metricsToday:         ["GET",    "/api/metrics/{propertyId}/today"],
    channelMix:           ["GET",    "/api/metrics/{propertyId}/channel-mix"],
    departmentRevenue:    ["GET",    "/api/metrics/{propertyId}/department-revenue"],

    /* halls and events */
    events:               ["GET",    "/api/events"],
    createEvent:          ["POST",   "/api/events"],
    event:                ["GET",    "/api/events/{eventId}"],
    confirmEvent:         ["POST",   "/api/events/{eventId}/confirm"],
    cancelEvent:          ["POST",   "/api/events/{eventId}/cancel"],
    eventDeposit:         ["POST",   "/api/events/{eventId}/deposit"],

    /* lost & found — the housekeeping register */
    lostFound:            ["GET",    "/api/lost-found"],
    exportLostFound:      ["GET",    "/api/lost-found/export"],
    logLostItem:          ["POST",   "/api/lost-found"],
    setLostItemStatus:    ["PATCH",  "/api/lost-found/{lostItemId}"],

    /* document register */
    documents:            ["GET",    "/api/documents"],
    exportDocuments:      ["GET",    "/api/documents/export"],
    document:             ["GET",    "/api/documents/{documentId}"],
    documentMetadata:     ["GET",    "/api/documents/{documentId}/metadata"],
    createDocument:       ["POST",   "/api/documents"],
    signDocument:         ["POST",   "/api/documents/{documentId}/sign"],
    sendDocument:         ["POST",   "/api/documents/{documentId}/send"],
    archiveDocument:      ["POST",   "/api/documents/{documentId}/archive"],
    purgeDocument:        ["DELETE", "/api/documents/{documentId}"],

    /* activity trail and notifications */
    activity:             ["GET",    "/api/activity"],
    logActivity:          ["POST",   "/api/activity"],
    notifications:        ["GET",    "/api/activity/notifications"],
    markNotification:     ["PATCH",  "/api/activity/notifications/{notificationId}"],
    markAllRead:          ["POST",   "/api/activity/notifications/mark-all-read"],

    /* the price catalogue */
    rateLists:            ["GET",    "/api/pricing/lists"],
    updateRateList:       ["PATCH",  "/api/pricing/lists/{listId}"],
    taxes:                ["GET",    "/api/pricing/taxes"],
    updateTax:            ["PATCH",  "/api/pricing/taxes/{taxId}"],
    ratePlans:            ["GET",    "/api/pricing/plans"],
    updateRatePlan:       ["PATCH",  "/api/pricing/plans/{planId}"],
    services:             ["GET",    "/api/pricing/services"],
    service:              ["GET",    "/api/pricing/services/{serviceId}"],
    createService:        ["POST",   "/api/pricing/services"],
    setServiceActive:     ["PATCH",  "/api/pricing/services/{serviceId}/active"],
    prices:               ["GET",    "/api/pricing/prices"],
    updatePrice:          ["PATCH",  "/api/pricing/prices/{priceId}"],
    previewPriceImport:   ["POST",   "/api/pricing/import/preview"],
    applyPriceImport:     ["POST",   "/api/pricing/import"],
    priceHistory:         ["GET",    "/api/pricing/history"],

    /* billing */
    invoices:             ["GET",    "/api/billing/invoices"],
    invoice:              ["GET",    "/api/billing/invoices/{invoiceId}"],
    raiseInvoice:         ["POST",   "/api/billing/invoices"],
    payInvoice:           ["POST",   "/api/billing/invoices/{invoiceId}/payments"],
    refundInvoice:        ["POST",   "/api/billing/invoices/{invoiceId}/refunds"],
    discountInvoice:      ["POST",   "/api/billing/invoices/{invoiceId}/discounts"],
    splitInvoice:         ["POST",   "/api/billing/invoices/{invoiceId}/split"],
    voidInvoice:          ["POST",   "/api/billing/invoices/{invoiceId}/void"],
    payments:             ["GET",    "/api/billing/payments"],
    refunds:              ["GET",    "/api/billing/refunds"],
    reconcilePayment:     ["PATCH",  "/api/billing/payments/{paymentId}/reconcile"],

    /* expenses, statements and financial settings */
    financialSettings:    ["GET",    "/api/finance/settings"],
    saveFinancialSettings:["PATCH",  "/api/finance/settings"],
    expenses:             ["GET",    "/api/finance/expenses"],
    recordExpense:        ["POST",   "/api/finance/expenses"],
    decideExpense:        ["POST",   "/api/finance/expenses/{expenseId}/decide"],
    statement:            ["GET",    "/api/finance/statement"],
    departmentStatement:  ["GET",    "/api/finance/statement/department"],

    /* exchange rates */
    fxRates:              ["GET",    "/api/fx/rates"],
    fxStates:             ["GET",    "/api/fx/states"],
    fileFxRate:           ["POST",   "/api/fx/rates"],

    /* the approval queue */
    approvals:            ["GET",    "/api/approvals"],
    approval:             ["GET",    "/api/approvals/{approvalId}"],
    decideApproval:       ["POST",   "/api/approvals/{approvalId}/decide"],

    /* night audit */
    auditPack:            ["GET",    "/api/audit/pack"],
    auditChecks:          ["GET",    "/api/audit/checks"],
    businessDate:         ["GET",    "/api/audit/business-date"],
    closedDates:          ["GET",    "/api/audit/closed"],
    runNightAudit:        ["POST",   "/api/audit/run"],

    /* laundry */
    laundryOrders:        ["GET",    "/api/laundry"],
    laundryOrder:         ["GET",    "/api/laundry/{orderId}"],
    createLaundryOrder:   ["POST",   "/api/laundry"],
    setLaundryStatus:     ["PATCH",  "/api/laundry/{orderId}/status"],

    /* reviews */
    reviews:              ["GET",    "/api/reviews"],
    reviewStats:          ["GET",    "/api/reviews/stats/{propertyId}"],
    review:               ["GET",    "/api/reviews/{reviewId}"],
    respondToReview:      ["POST",   "/api/reviews/{reviewId}/respond"]
  };

  var api = {};
  Object.keys(DOORS).forEach(function (name) {
    var door = DOORS[name];
    api[name] = function () {
      var args = Array.prototype.slice.call(arguments);
      var taken = 0;
      var path = door[1].replace(/\{(\w+)\}/g, function (_m, slot) {
        var value = args[taken++];
        // An unfilled slot would send "/api/reservations//folio", which the
        // router answers as its own 404 — a confusing one, from a caller that
        // looked like it was asking for a folio.
        if (value === undefined || value === null || value === "") {
          throw new Error("api." + name + ": " + slot + " is required.");
        }
        return encodeURIComponent(value);
      });
      var rest = args.slice(taken);
      var reads = door[0] === "GET" || door[0] === "DELETE";
      return req(door[0], path, reads ? undefined : rest[0], reads ? rest[0] : rest[1]);
    };
  });

  /* These three own the session token; nothing else in the file touches it. */
  var login = api.login, guestSignIn = api.guestSignIn, logout = api.logout;
  api.login = function (email, password) {
    return login({ email: email, password: password }).then(function (data) {
      setToken(data.token);
      return data;
    });
  };
  api.guestSignIn = function (contact) {
    return guestSignIn(contact).then(function (data) {
      setToken(data.token);
      return data;
    });
  };
  api.logout = function () {
    // The door needs the token to be believed, so it goes first and the
    // session is dropped whatever the answer is.
    return logout().catch(function () {}).then(clearToken);
  };

  LHMS.api = api;
})();
