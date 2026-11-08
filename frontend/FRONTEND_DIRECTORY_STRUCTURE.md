# WeKnora 前端目录结构

> 目录位置：`frontend/`
>
> 本文只展示目录结构，不逐文件说明用途。`node_modules/`、`dist/`、`.vite/` 以及 `.ua/intermediate/`、`.ua/tmp/` 等依赖、构建产物和临时分析文件未展开。

```text
frontend/
├─ .dockerignore
├─ .gitignore
├─ Dockerfile
├─ docker-entrypoint.sh
├─ embed.html
├─ env.d.ts
├─ index.html
├─ mcpProxy.test.ts
├─ nginx.conf
├─ nginx-api-proxy.conf
├─ nginx-http.conf
├─ package.json
├─ package.json.md5
├─ package-lock.json
├─ pnpm-workspace.yaml
├─ tsconfig.app.json
├─ tsconfig.json
├─ tsconfig.node.json
├─ vite.config.ts
│
├─ .ua/                         # Understanding-Anything 分析数据（未展开）
│
├─ e2e/
│
├─ public/
│  └─ tdesign-icons/
│     └─ 0.4.1/
│        └─ fonts/
│
├─ scripts/
│
├─ tests/
│  └─ source-locate/
│     └─ local/
│
└─ src/
   ├─ App.vue
   ├─ main.ts
   ├─ embed-main.ts
   ├─ .ua/                      # src 小范围知识图谱数据（临时目录未展开）
   │
   ├─ api/
   │  ├─ agent/
   │  ├─ auth/
   │  ├─ chat/
   │  ├─ chunker/
   │  ├─ datasource/
   │  ├─ embed/
   │  ├─ image-gallery/
   │  ├─ initialization/
   │  ├─ knowledge-base/
   │  ├─ model/
   │  ├─ organization/
   │  ├─ skill/
   │  ├─ system/
   │  ├─ tenant/
   │  └─ wiki/
   │
   ├─ assets/
   │  ├─ browserskill/
   │  ├─ theme/
   │  └─ img/
   │     ├─ im/
   │     └─ providers/
   │        ├─ color/
   │        │  ├─ storage/
   │        │  ├─ vectorstore/
   │        │  └─ websearch/
   │        └─ mono/
   │           ├─ sandbox/
   │           ├─ storage/
   │           ├─ vectorstore/
   │           └─ websearch/
   │
   ├─ components/
   │  ├─ assistant/
   │  ├─ chat/
   │  ├─ credentials/
   │  ├─ css/
   │  ├─ GlobalCommandPalette/
   │  ├─ icons/
   │  ├─ settings/
   │  ├─ source-preview/
   │  └─ upload-tasks/
   │
   ├─ composables/
   ├─ config/
   ├─ directives/
   ├─ hooks/
   │
   ├─ i18n/
   │  └─ locales/
   │     └─ embed/
   │
   ├─ router/
   ├─ stores/
   ├─ test-utils/
   ├─ types/
   ├─ utils/
   │
   ├─ views/
   │  ├─ agent/
   │  ├─ artifacts/
   │  ├─ auth/
   │  ├─ automation/
   │  ├─ chat/
   │  │  └─ components/
   │  │     └─ tool-results/
   │  ├─ creatChat/
   │  ├─ dev/
   │  ├─ embed/
   │  ├─ integrations/
   │  ├─ knowledge/
   │  │  ├─ components/
   │  │  ├─ gallery/
   │  │  ├─ settings/
   │  │  ├─ utils/
   │  │  └─ wiki/
   │  ├─ organization/
   │  ├─ platform/
   │  ├─ settings/
   │  │  └─ components/
   │  ├─ system/
   │  └─ toolbox/
   │
   └─ wailsjs/
      ├─ go/
      │  └─ main/
      └─ runtime/
```

## 顶层目录速览

```text
frontend/
├─ e2e/       # 端到端测试目录
├─ public/    # 无需打包处理、直接公开的静态资源
├─ scripts/   # 构建与资源处理脚本
├─ src/       # 前端应用源码
└─ tests/     # 独立测试夹具与测试资源
```

## `src` 一级目录速览

```text
src/
├─ api/          # 后端接口调用模块
├─ assets/       # 图片、主题与样式资源
├─ components/   # 可复用 Vue 组件
├─ composables/  # Vue Composition API 组合逻辑
├─ config/       # 前端静态配置
├─ directives/   # Vue 自定义指令
├─ hooks/        # 功能 Hook
├─ i18n/         # 国际化配置和语言包
├─ router/       # Vue Router 路由配置
├─ stores/       # Pinia 状态管理
├─ test-utils/   # 测试辅助工具
├─ types/        # TypeScript 类型声明
├─ utils/        # 通用工具函数
├─ views/        # 路由页面和业务页面
└─ wailsjs/      # Wails 桌面端桥接代码
```
