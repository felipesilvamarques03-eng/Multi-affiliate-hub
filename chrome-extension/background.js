// Ao clicar no ícone: volta para a aba do painel se ela já estiver aberta, senão abre uma nova.
const PANEL = 'https://multi-affiliate-hub.netlify.app/app/';

chrome.action.onClicked.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: PANEL + '*' });
  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: PANEL });
  }
});
