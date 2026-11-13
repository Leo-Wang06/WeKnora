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

/**
 * 应用启动入口：创建 Vue 实例、安装插件，并在首屏渲染前完成必要初始化。
 *
 * 执行顺序（顺序有依赖，不要随意调整）：
 * 1. 注册全局错误处理，避免组件内未捕获异常导致整页白屏
 * 2. 安装 TDesign 和 Pinia（auth store 依赖 Pinia 已安装）
 * 3. 本地存在 token 时，先 await /auth/me 校准用户与能力开关，
 *    保证首帧渲染时权限相关 UI 不闪烁；失败则保持默认值，不阻断启动
 * 4. 安装 router / i18n，并 await router.isReady() 后再挂载，
 *    避免先渲染默认路由再跳转造成闪屏（Lite 自动登录也在这期间完成）
 * 5. 挂载完成后再安装表单自动填充抑制
 */
async function bootstrap() {
  const app = createApp(App);

  /**
   * 全局错误处理：捕获未处理的组件错误，防止白屏，只打印日志
   * 
   * @param err 抛出的错误
   * @param instance 出错的组件实例
   * @param info Vue 提供的错误上下文
   */
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

  installAutofillGuard();
}

bootstrap();
