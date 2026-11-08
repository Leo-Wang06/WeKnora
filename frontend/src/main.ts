import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import router from "./router";
import TDesign from "tdesign-vue-next";
// 引入组件库的少量全局样式变量
import "tdesign-vue-next/dist/tdesign.css";
import "@/assets/theme/theme.css";
import "@/assets/theme/tdesign-overrides.less";
import "@/assets/dropdown-menu.less";
import "@/components/css/chat-hljs-dark.less";
import "@/components/css/assistant-page-fill.less";
// vue-virtual-scroller ships its own tiny stylesheet — required for
// RecycleScroller/DynamicScroller to size their viewport correctly.
// Without it the scroller computes 0 height and renders no items.
import "vue-virtual-scroller/dist/vue-virtual-scroller.css";
import i18n from "./i18n";
import { initTheme } from "@/composables/useTheme";
import { initFont } from "@/composables/useFont";
import { installTDesignIconOfflineGuard } from "@/utils/tdesign-icon-offline";
import { installAutofillGuard } from "@/utils/disable-autofill";
import { useAuthStore } from "@/stores/auth";

// 必须在 Vue 组件挂载之前执行，避免 tdesign-icons 运行时请求 tdesign.gtimg.com
installTDesignIconOfflineGuard();

initTheme();
initFont();

async function bootstrap() {
  const app = createApp(App);

  // 全局错误处理：捕获未处理的组件错误，防止白屏，只打印日志
  app.config.errorHandler = (err, instance, info) => {
    console.error("[WeKnora] Unhandled Vue error:", err, "\nComponent:", instance, "\nInfo:", info);
  };

  // 安装 TDesign + 创建并安装 Pinia
  app.use(TDesign);
  const pinia = createPinia();
  app.use(pinia);

  // Capabilities (can_create_tenant, auto_accept_invitation) are not cached
  // in localStorage — reconcile once before first paint when a session exists.
  const authStore = useAuthStore();
  if (localStorage.getItem("weknora_token")) {
    try {
      await authStore.refreshFromAuthMe();
    } catch {
      // best-effort; capabilities stay at defaults until the next refresh
    }
  }

  app.use(router);
  app.use(i18n);

  // 等首屏路由（含导航守卫、Lite 自动登录）完成后再挂载，避免先闪默认页再跳转
  // 这是很常见的坑规避手段。如果直接 mount，Vue 会先渲染初始路由（可能是默认页），导航守卫跑完再跳走，用户会看到闪屏。await router.isReady() 保证第一次导航完全落定后才出第一帧，同时也让 Lite 版的自动登录逻辑跑完。
  await router.isReady();
  app.mount("#app");
  // 全局给页面里的表单控件打上 autocomplete 属性，抑制浏览器和密码管理器的自动填充。
  /**为什么需要它
    WeKnora 是个聊天 + 知识库应用，页面上到处是文本框：聊天输入框、搜索框、改名框、API Key / Secret 的配置框……

    如果没有这个守卫，实际会遇到的问题：

    密码管理器误判：Chrome / 1Password / Bitwarden 会把「密码框附近的文本框」当成用户名，或者把搜索框识别成登录框，弹出填充下拉——挡住聊天输入框的 UI
    自动弹出保存/生成密码：设置页里的密码输入框会触发「保存密码」或「生成强密码」提示，对产品来说是噪音
    历史值下拉：普通输入框会弹出以前输入过的内容（Chrome 的 form autofill），在搜索、重命名这类场景里很干扰
    注意它不影响登录：登录页的输入框显式声明了 autocomplete，会被跳过，所以正常的保存密码流程照常工作。 
  */
  installAutofillGuard();
}

bootstrap();
