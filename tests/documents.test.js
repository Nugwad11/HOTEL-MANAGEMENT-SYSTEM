const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function loadDocuments(role, guestId = null) {
  const document = {
    id: 'doc-1', propertyId: 'hotel-1', guestId: 'guest-1', reservationId: 'res-1',
    category: 'Billing', name: 'Invoice', status: 'Available', signedAt: null
  };
  const ownGuestDoc = {
    id: 'doc-2', propertyId: 'hotel-1', guestId: 'guest-1', reservationId: 'res-1',
    category: 'Registration', name: 'Registration card', status: 'Available', signedAt: null, guestVisible: true
  };
  const LHMS = {
    db: { documents: [document, ownGuestDoc], properties: [] },
    session: { role, propertyId: 'hotel-1', guestId },
    pages: {}, uiActions: {}, forms: {},
    save() { this.saved = true; },
    log(action, entity, detail) { (this.audit ||= []).push({ action, entity, detail }); }
  };
  const context = { window: { LHMS }, console, Date, Math, JSON, Object, Array, String };
  const source = fs.readFileSync(path.join(__dirname, '../assets/pages-documents.js'), 'utf8');
  vm.runInNewContext(source, context, { filename: 'pages-documents.js' });
  return { LHMS, document, ownGuestDoc };
}

test('housekeeping cannot view a billing document', () => {
  const { LHMS, document } = loadDocuments('Housekeeping');
  assert.equal(LHMS.documents.canAccess(document, 'view'), false);
});

test('guest can view only their own registration document', () => {
  const { LHMS, document, ownGuestDoc } = loadDocuments('Guest', 'guest-1');
  assert.equal(LHMS.documents.canAccess(ownGuestDoc, 'view'), true);
  assert.equal(LHMS.documents.canAccess(document, 'view'), false);
  assert.equal(LHMS.documents.canAccess(ownGuestDoc, 'export'), false);
});

test('registration signing requires an authorized role and a typed signer name', () => {
  const { LHMS, ownGuestDoc } = loadDocuments('Front Desk');
  assert.equal(LHMS.documents.sign(ownGuestDoc.id, '' ).ok, false);
  assert.equal(ownGuestDoc.signedAt, null);
  const result = LHMS.documents.sign(ownGuestDoc.id, 'Adaeze Nwankwo');
  assert.equal(result.ok, true);
  assert.equal(ownGuestDoc.signedBy, 'Adaeze Nwankwo');
  assert.ok(ownGuestDoc.signedAt);
  assert.ok(LHMS.audit.some((entry) => entry.action === 'signed a document'));
});

test('only a manager can archive a document', () => {
  const staff = loadDocuments('Front Desk');
  assert.equal(staff.LHMS.documents.archive(staff.document.id).ok, false);
  const manager = loadDocuments('Manager');
  assert.equal(manager.LHMS.documents.archive(manager.document.id).ok, true);
  assert.equal(manager.document.status, 'Archived');
});
