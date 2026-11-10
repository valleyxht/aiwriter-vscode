# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

AI Writer 是一个 VSCode 插件，提供小说创作的原生功能作为 AI 写作辅助的载体。该插件实现了会话管理、选中文本收集、文件差异对比、侧边栏对话面板等功能，并集成主 Agent、可选专业 Agent、本地 RAG 和 LangSmith 观测。

## Development Commands

### 编译和构建
```bash
# 编译 TypeScript 并复制 webview 文件
npm run compile

# 仅编译 TypeScript
tsc -p ./

# 仅复制 webview 文件到输出目录
npm run copy-webview
```

### 测试和调试
```bash
# 不启动 VS Code 的单元测试
npm run test:unit

# VS Code 扩展测试
npm test

# 代码检查
npm run lint
```

### 开发模式
```bash
# 监听文件变化并自动编译
npm run watch
```

## Architecture

### 核心模块 (`src/core/`)
- **session.ts**: 会话管理（创建、加载、保存、删除、重命名、历史管理）
- **selection.ts**: 选中文本管理（收集、删除、工作空间隔离）
- **diff.ts**: 文件差异对比（VSCode 原生 Diff 编辑器、接受/拒绝）
- **storage.ts**: 本地数据存储（基于 workspaceState/globalState）
- **ui.ts**: UI 命令管理（注册所有命令和处理器）

### Webview 层 (`src/webview/`)
- **provider.ts**: SidebarWebviewProvider，实现侧边栏面板
- **protocol.ts**: Webview 通信协议，双向消息传递
- **html/**: 前端资源（index.html、styles.css、main.js）

### 类型定义 (`src/types.ts`)
- 基础类型：Position、Range、RangeInFile、RangeInFileWithContents
- 会话相关：Session、SessionMetadata、ChatMessage
- 其他：CollectedText、DiffResult

### AI 与检索层
- **src/ai/manager.ts**: 配置、请求生命周期与专业工具注册
- **src/ai/runtime/**: 主 Agent、流式输出、上下文预算和请求观测
- **src/ai/models/**: 模型工厂、厂商兼容配置与调用策略
- **src/ai/tools/**: 文件、RAG、网络工具和跨工具证据去重
- **src/workers/specialists/**: 资料检索、提示词拆解和写作审核工具；由主 Agent 自行决定调用
- **src/memory/**: 项目记忆、写作偏好、本地 RAG 索引与 Token 统计
- 提示词保存在 JSON 资源中；不再使用固定规划器、写作准备链或草稿暂存链。

## Key Files

- **extension.ts**: 插件主入口，初始化所有管理器
- **package.json**: 插件配置（命令、菜单、快捷键、设置项）
- **tsconfig.json**: TypeScript 编译配置
- **scripts/copy-webview.js**: 复制 webview 资源到输出目录

## 重要实现细节

### 会话持久化
- 会话数据存储在 globalState 中（键: `aiwriter.sessions`）
- 活跃会话 ID 存储在 globalState 中（键: `aiwriter.activeSession`）
- 每个工作空间的选中文本存储在 workspaceState 中（键: `workspace:{workspacePath}:aiwriter.selections`）

### Webview 通信
- Extension → Webview: 使用 protocol.sendMessage()
- Webview → Extension: 通过 webview.onDidReceiveMessage 接收，使用 protocol.handleMessage() 处理
- 消息类型定义在 protocol.ts 中（ExtensionToWebviewMessage、WebviewToExtensionMessage）

### Diff 实现
- 使用虚拟文档提供者（DiffDocumentProvider）注册自定义 URI scheme
- 调用 VSCode 原生 diff 命令显示差异
- 用户确认后使用 WorkspaceEdit 应用修改

### 命令注册
- 所有命令在 package.json 的 contributes.commands 中定义
- 快捷键在 keybindings 中定义
- 右键菜单在 menus.editor/context 中定义
- UI 命令处理器在 core/ui.ts 中实现

## 调试技巧

1. 按 F5 启动扩展开发主机
2. 使用 Ctrl+Shift+I 打开开发者工具
3. 查看 Console 标签获取日志输出
4. 使用 "VS Code 扩展开发主机" 窗口测试插件功能

## 测试插件功能

1. **侧边栏测试**: 点击左侧活动栏的 AI Writer 图标
2. **会话管理测试**: 新建、切换、删除会话
3. **选中文本测试**: 选中编辑器中的文本，右键选择"收集选中文本"
4. **对话测试**: 在输入框中输入内容并发送
5. **持久化测试**: 重启 VSCode 后验证数据保存

## Git 操作约定

- 创建或切换分支、查看状态和差异、暂存、提交、拉取及推送时，优先直接使用原生 `git` 命令。
- 不要因为缺少 GitHub CLI (`gh`) 而阻止仅需 `git` 即可完成的提交或推送操作。
- 只有创建或管理 GitHub Pull Request、Issue 等原生 `git` 不支持的 GitHub 平台操作时，才使用 `gh` 或 GitHub 连接器。

## 注意事项

1. 所有异步操作都应包含错误处理
2. 使用 vscode.window.showErrorMessage() 显示用户友好的错误信息
3. 记录详细的错误日志用于调试
4. 修改后记得运行 npm run compile
5. webview HTML/CSS/JS 文件修改后需要重新编译
