import { test, expect } from '@playwright/test';

test('real OCR uses local resources and preserves numeric training instructions', async ({ page }) => {
  await page.route('**/api/**', route => route.fulfill({ json: {} }));
  await page.goto('/');
  const extraction = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 1200; canvas.height = 400;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 1200, 400);
    ctx.translate(15, 0); ctx.rotate(3 * Math.PI / 180);
    ctx.fillStyle = 'black'; ctx.font = '48px Arial';
    ctx.fillText('12/01/2027 - Course', 50, 100);
    ctx.fillText('6 x 400 m - récupération 90 secondes', 50, 200);
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!)));
    // Vite serves the same lazy module the upload flow imports.
    const modulePath = '/src/lib/documentExtraction.ts';
    const { extractDocument } = await import(/* @vite-ignore */ modulePath);
    return extractDocument(new File([blob], 'scan.png', { type: 'image/png' }), new AbortController().signal, () => {});
  });
  const text = extraction.blocks.map((block: { text: string }) => block.text).join(' ');
  expect(text).toContain('400');
  expect(text).toContain('90');
  expect(text).toContain('2027');
  expect(extraction.blocks.every((block: { method: string }) => block.method === 'ocr')).toBe(true);
});

test('file drop creates sessions directly and preserves attachments on reload', async ({ page }) => {
  const docId = '11111111-1111-4111-8111-111111111111';
  let documentReady = false;
  const importRequests: string[] = [];
  const doc = { id: docId, name: 'plan.md', size: 18, sha256: '0'.repeat(64), status: 'ready' };
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname.includes('/imports')) { importRequests.push(url.pathname); return route.fulfill({ status: 404 }); }
    if (url.pathname.endsWith('/documents') && method === 'POST') return route.fulfill({ json: doc });
    if (url.pathname.includes('/chunks/')) return route.fulfill({ json: { uploaded: true } });
    if (url.pathname.endsWith('/finalize')) { documentReady = true; return route.fulfill({ json: doc }); }
    if (url.pathname.endsWith('/documents')) return route.fulfill({ json: documentReady ? [doc] : [] });
    if (url.pathname.endsWith('/chat/stream')) {
      expect(route.request().postDataJSON().messages.at(-1).content).toBe('Crée cette séance');
      const events = [
        { type: 'tool_start', id: 'create-1', name: 'create_planned_session', args: { text: '2027-01-12, endurance', truncated: false } },
        { type: 'tool_end', id: 'create-1', name: 'create_planned_session', status: 'done', output: { text: 'Séance 42 créée', truncated: false }, elapsed_ms: 20 },
        { type: 'message', id: 'answer', text: 'Séance créée dans le planning.' },
        { type: 'done', message: { role: 'assistant', content: 'Séance créée dans le planning.' } },
      ];
      return route.fulfill({ contentType: 'text/event-stream', body: events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') });
    }
    if (url.pathname.includes('/settings')) return route.fulfill({ json: {} });
    return route.fulfill({ json: [] });
  });
  await page.goto('/planning');
  await page.getByRole('button', { name: 'Ouvrir le coach' }).first().click();
  const transfer = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(new File(['Footing 30 minutes'], 'plan.md', { type: 'text/markdown' }));
    return data;
  });
  await page.locator('aside').filter({ has: page.getByLabel('Documents du coach') }).dispatchEvent('drop', { dataTransfer: transfer });
  await expect(page.getByText('Prêt', { exact: true })).toBeVisible();
  await page.getByLabel('Message au coach').fill('Crée cette séance');
  await page.getByRole('button', { name: 'Envoyer', exact: true }).click();
  await expect(page.getByText('Séance créée dans le planning.')).toBeVisible();
  await expect(page.getByRole('button', { name: /Vérifier.*séance/ })).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: 'Ouvrir le coach' }).first().click();
  await expect(page.getByText('plan.md', { exact: true })).toBeVisible();
  await expect(page.getByText('Séance créée dans le planning.')).toBeVisible();
  expect(importRequests).toEqual([]);
});


test('PDF upload delegates extraction to the server without a browser OCR worker', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', request => requests.push(request.url()));
  await page.route('**/api/**', route => {
    if (route.request().url().endsWith('/finalize')) expect(route.request().postDataJSON()).toBeNull();
    return route.fulfill({ json: { id: 'pdf', status: 'ready' } });
  });
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const modulePath = '/src/lib/documents.ts';
    const { uploadDocument } = await import(/* @vite-ignore */ modulePath);
    return uploadDocument('thread', new File(['%PDF-server-validation'], 'scan.pdf'), new AbortController().signal, () => {});
  });
  expect(result.status).toBe('ready');
  expect(requests.some(url => url.includes('/finalize'))).toBe(true);
  expect(requests.some(url => url.includes('/ocr/') || url.includes('documentExtraction'))).toBe(false);
});

test('Garmin export is an explicit selected action and never claims watch delivery', async ({ page }) => {
  const day = new Date().toISOString().slice(0, 10);
  const session = { id: 42, date: day, sport: 'running', session_type: 'endurance', description: 'Footing de référence', source: 'coach', status: 'pending', revision: 1, prescription: { version: 1, steps: [{ kind: 'effort', duration_kind: 'seconds', value: 1800, steps: [] }] } };
  let sent = 0;
  let statuses: object[] = [];
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/garmin/planned')) return route.fulfill({ json: [session] });
    if (path.endsWith('/42/workout')) return route.fulfill({ json: { session: { ...session, exportable: true, summary: '30 min' }, export: statuses[0] ?? null } });
    if (path.endsWith('/workout-devices')) return route.fulfill({ json: [{ id: 10, name: 'fēnix 8', sports: ['running'], compatibility: 'documented' }, { id: 11, name: 'Modèle inconnu', sports: [], compatibility: 'unknown' }] });
    if (path.endsWith('/garmin/exports')) return route.fulfill({ json: statuses });
    if (path.endsWith('/exports/batch')) {
      expect(route.request().postDataJSON()).toEqual({ session_ids: [42], revisions: [1], device_id: 10 });
      sent++;
      statuses = [{ session_id: 42, state: 'transfer_requested', error: null, workout_id: 50, schedule_id: 60, deleted: false }];
      return route.fulfill({ json: { results: statuses, not_attempted: [] } });
    }
    return route.fulfill({ json: [] });
  });
  await page.goto('/planning');
  const panel = page.getByRole('region', { name: 'Envoi des séances vers Garmin' });
  await panel.getByLabel('Sélectionner Footing de référence').check();
  await panel.getByLabel('Demander aussi le transfert vers une montre').check();
  await panel.getByLabel('Montre Garmin').selectOption('10');
  await expect(panel.getByRole('option', { name: /Modèle inconnu/ })).toHaveJSProperty('disabled', true);
  const send = panel.getByRole('button', { name: 'Envoyer vers Garmin' });
  await expect(send).toBeEnabled();
  expect(sent).toBe(0);
  await send.click();
  await expect(panel.getByText('Transfert demandé · synchronise la montre', { exact: true })).toBeVisible();
  expect(sent).toBe(1);
  await expect(panel.getByText('Reçu sur la montre', { exact: true })).toHaveCount(0);
});

test('OCR preview compares the original, filters uncertain passages and works on mobile', async ({ page }) => {
  const { createHash } = await import('node:crypto');
  const lines = ['PROGRAMME · SEMAINE 04', 'Course à pied', 'Mardi 12 janvier 2027', 'Échauffement : 15 min en aisance', '6 × 400 m à 4:30/km', 'Récupération : 90 s entre chaque effort', 'Retour au calme : 10 min', 'Objectif : régularité, sans finir à bloc.'];
  const encoded = await page.evaluate(text => {
    const canvas = document.createElement('canvas'); canvas.width = 900; canvas.height = 1160;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fafaf8'; ctx.fillRect(0, 0, 900, 1160);
    ctx.fillStyle = '#087e8b'; ctx.fillRect(64, 72, 60, 5);
    ctx.font = 'bold 25px Arial'; ctx.fillText(text[0], 64, 132);
    ctx.fillStyle = '#15282b'; ctx.font = 'bold 48px Arial'; ctx.fillText(text[1], 64, 214);
    ctx.fillStyle = '#6c7a7c'; ctx.font = '23px Arial'; ctx.fillText(text[2], 64, 270);
    ctx.fillStyle = '#e9eeee'; ctx.fillRect(64, 315, 772, 2);
    for (let i = 3; i < text.length; i++) {
      if (i === 4) { ctx.fillStyle = '#e5f3f1'; ctx.fillRect(48, 440, 804, 88); }
      ctx.fillStyle = i === 4 ? '#087e8b' : '#263c40'; ctx.font = `${i === 4 ? 'bold ' : ''}27px Arial`; ctx.fillText(text[i], 64, 395 + (i-3)*100);
    }
    ctx.fillStyle = '#8c999b'; ctx.font = '18px Arial'; ctx.fillText('PLAN PERSONNEL / 01', 64, 1080);
    return canvas.toDataURL('image/png').split(',')[1];
  }, lines);
  const raw = Buffer.from(encoded, 'base64');
  const doc = { id: '11111111-1111-4111-8111-111111111111', name: 'Programme semaine 04.png', size: raw.length, sha256: createHash('sha256').update(raw).digest('hex'), status: 'ready' };
  let downloads = 0;
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/documents')) return route.fulfill({ json: [doc] });
    if (path.endsWith('/extraction')) return route.fulfill({ json: { warnings: ['Texte reconnu automatiquement : vérifie les dates, chiffres et unités dans l’original.'], blocks: lines.map((text, i) => ({ locator: `page 1, ligne ${i+1}`, text, method: 'ocr', confidence: i === 4 ? 61 : 96 })) } });
    if (path.endsWith('/chunks/0')) { downloads++; return route.fulfill({ body: raw, contentType: 'application/octet-stream' }); }
    return route.fulfill({ json: [] });
  });
  await page.goto('/planning');
  await page.getByRole('button', { name: 'Ouvrir le coach' }).first().click();
  await page.getByRole('button', { name: `Consulter ${doc.name}` }).click();
  const preview = page.getByRole('dialog', { name: `Aperçu de ${doc.name}` });
  await expect(preview.getByRole('img', { name: `Original : ${doc.name}` })).toBeVisible();
  await expect.poll(() => preview.getByRole('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(900);
  const loadedDownloads = downloads;
  await preview.getByRole('button', { name: 'Agrandir l’original' }).click();
  await expect(preview.getByRole('img')).toHaveAttribute('style', 'width: 125%;');
  await preview.getByRole('button', { name: 'Réinitialiser le zoom' }).click();
  await expect(preview.getByText('Récupération : 90 s entre chaque effort', { exact: true })).toBeVisible();
  await preview.getByRole('button', { name: '1 à vérifier', exact: true }).click();
  await expect(preview.getByText('Récupération : 90 s entre chaque effort', { exact: true })).toHaveCount(0);
  await expect(preview.getByText('6 × 400 m à 4:30/km', { exact: true })).toBeVisible();
  await preview.getByRole('button', { name: 'Afficher tout', exact: true }).click();
  await preview.getByText('6 × 400 m à 4:30/km', { exact: true }).click();
  await expect(preview.getByText('page 1, ligne 5 · confiance OCR 61 %', { exact: true })).toBeVisible();
  await page.screenshot({ path: '../.context/ocr-preview-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(preview.getByRole('img')).not.toBeVisible();
  await preview.getByRole('button', { name: 'Original', exact: true }).click();
  await expect(preview.getByRole('img')).toBeVisible();
  await preview.getByRole('button', { name: 'Texte extrait', exact: true }).click();
  await expect(preview.getByText('6 × 400 m à 4:30/km', { exact: true })).toBeVisible();
  await page.screenshot({ path: '../.context/ocr-preview-mobile.png' });
  expect(downloads).toBe(loadedDownloads);
  await page.keyboard.press('Escape');
  await expect(preview).toHaveCount(0);
  await expect(page.getByRole('button', { name: `Consulter ${doc.name}` })).toBeFocused();
});
