function setPrompt(text) {
  const input = document.getElementById('prompt-input');
  if (input) {
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  }
}

function submitPrompt() {
  const input = document.getElementById('prompt-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;

  const container = document.getElementById('chat-messages');
  if (!container) return;

  // User message
  const userMsg = document.createElement('div');
  userMsg.className = 'msg msg-user';
  userMsg.innerText = text;
  container.appendChild(userMsg);

  input.value = '';

  // Bot response
  setTimeout(() => {
    const botMsg = document.createElement('div');
    botMsg.className = 'msg msg-bot';
    botMsg.innerText = 'Received prompt: "' + text + '". Submission was permitted by organization policy.';
    container.appendChild(botMsg);
    container.scrollTop = container.scrollHeight;
  }, 500);

  container.scrollTop = container.scrollHeight;
}

document.addEventListener('DOMContentLoaded', () => {
  const presetButtons = document.querySelectorAll('.preset-btn[data-prompt]');
  presetButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const prompt = btn.getAttribute('data-prompt');
      if (prompt) setPrompt(prompt);
    });
  });

  const siteBlockBtn = document.getElementById('test-site-block-btn');
  if (siteBlockBtn) {
    siteBlockBtn.addEventListener('click', () => {
      window.location.href = 'https://www.ilovepdf.com/';
    });
  }

  const sendBtn = document.getElementById('send-btn');
  if (sendBtn) {
    sendBtn.addEventListener('click', submitPrompt);
  }

  const promptInput = document.getElementById('prompt-input');
  if (promptInput) {
    promptInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submitPrompt();
      }
    });
  }
});
