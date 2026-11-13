/**
 * Globally discourage browser/password-manager autofill on app inputs.
 * Skips elements that already declare autocomplete (e.g. login email).
 */
function guardElement(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) {
  const explicit = el.getAttribute('autocomplete');
  if (explicit !== null && explicit !== '') return;
  if (el.closest('[data-allow-autofill]')) return;

  if (el instanceof HTMLInputElement && el.type === 'password') {
    el.setAttribute('autocomplete', 'new-password');
  } else {
    el.setAttribute('autocomplete', 'off');
  }
}

function guardTree(root: ParentNode) {
  if (root instanceof HTMLInputElement || root instanceof HTMLTextAreaElement || root instanceof HTMLSelectElement) {
    guardElement(root);
  }

  root.querySelectorAll?.('input, textarea, select').forEach((node) => {
    guardElement(node as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement);
  });

  root.querySelectorAll?.('form').forEach((form) => {
    if (!form.hasAttribute('autocomplete')) {
      form.setAttribute('autocomplete', 'off');
    }
  });
}

let installed = false;

/**
 * 全局给页面里的表单控件打上 autocomplete 属性，抑制浏览器和密码管理器的自动填充。
 * 为什么需要它
  WeKnora 是个聊天 + 知识库应用，页面上到处是文本框：聊天输入框、搜索框、改名框、API Key / Secret 的配置框……

  如果没有这个守卫，实际会遇到的问题：

  密码管理器误判：Chrome / 1Password / Bitwarden 会把「密码框附近的文本框」当成用户名，或者把搜索框识别成登录框，弹出填充下拉——挡住聊天输入框的 UI
  自动弹出保存/生成密码：设置页里的密码输入框会触发「保存密码」或「生成强密码」提示，对产品来说是噪音
  历史值下拉：普通输入框会弹出以前输入过的内容（Chrome 的 form autofill），在搜索、重命名这类场景里很干扰
  注意它不影响登录：登录页的输入框显式声明了 autocomplete，会被跳过，所以正常的保存密码流程照常工作。 
*/
export function installAutofillGuard() {
  if (installed || typeof document === 'undefined') return;
  installed = true;

  guardTree(document);

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (node instanceof HTMLElement) {
          guardTree(node);
        }
      });
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
}
