const form = document.querySelector('#clip-form');
const videoInput = document.querySelector('#video');
const fileName = document.querySelector('#file-name');
const submitButton = document.querySelector('#submit');
const statusPanel = document.querySelector('#status');
const resultsPanel = document.querySelector('#results');
const clipLinks = document.querySelector('#clip-links');

videoInput.addEventListener('change', () => {
  fileName.textContent = videoInput.files[0]?.name || 'No file selected';
});

function setStatus(message, kind = 'working') {
  statusPanel.hidden = false;
  statusPanel.className = kind;
  statusPanel.textContent = message;
}

async function readJson(response) {
  const body = await response.json().catch(() => null);
  if (!body) throw new Error(`Server returned HTTP ${response.status}.`);
  return body;
}

async function uploadVideo(file) {
  const data = new FormData();
  data.append('video', file);
  const response = await fetch('/uploads', { method: 'POST', body: data });
  const body = await readJson(response);
  if (!response.ok) throw new Error(body.error?.message || 'Video preparation failed.');
  return body;
}

async function requestClips(body, paymentSignature) {
  const headers = { 'Content-Type': 'application/json' };
  if (paymentSignature) headers['Payment-Signature'] = paymentSignature;
  return fetch('/clip', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function renderClips(clips) {
  clipLinks.replaceChildren();
  clips.forEach((clip, index) => {
    const link = document.createElement('a');
    link.href = clip.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = `Open clip ${index + 1} (${clip.durationSeconds.toFixed(1)}s)`;
    clipLinks.append(link);
  });
  resultsPanel.hidden = false;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = videoInput.files[0];
  if (!file) return;

  submitButton.disabled = true;
  resultsPanel.hidden = true;
  try {
    setStatus('Uploading and validating your video…');
    const prepared = await uploadVideo(file);
    const clipRequest = {
      uploadId: prepared.uploadId,
      clipCount: Number(document.querySelector('#clip-count').value),
      minDurationSeconds: Number(document.querySelector('#min-duration').value),
      maxDurationSeconds: Number(document.querySelector('#max-duration').value),
    };

    setStatus('Requesting OKX payment authorization…');
    let response = await requestClips(clipRequest);
    if (response.status === 402) {
      const challenge = response.headers.get('payment-required');
      const paymentEvent = new CustomEvent('clipagent:payment-required', {
        cancelable: true,
        detail: {
          challenge,
          request: Object.freeze({ ...clipRequest }),
          replay: async (paymentSignature) => requestClips(clipRequest, paymentSignature),
        },
      });
      window.dispatchEvent(paymentEvent);
      if (!paymentEvent.defaultPrevented) {
        setStatus(
          'Payment authorization is required. Open ClipAgent through an OKX x402-capable buyer to continue.',
          'payment'
        );
        return;
      }
      if (!paymentEvent.detail.response) {
        throw new Error('The payment integration did not provide a replay response.');
      }
      setStatus('Payment authorized. Generating your clips…');
      response = await paymentEvent.detail.response;
    }

    const result = await readJson(response);
    if (!response.ok) throw new Error(result.error?.message || 'Clip generation failed.');
    renderClips(result.clips);
    setStatus('Your clips are ready.', 'success');
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    submitButton.disabled = false;
  }
});
