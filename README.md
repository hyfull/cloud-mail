<p align="center">
    <img src="doc/demo/logo.png" width="80px" />
    <h1 align="center">Cloud Mail</h1>
    <p align="center">基于 Cloudflare 的简约响应式邮箱服务，支持邮件发送、附件收发 🎉</p> 
    <p align="center">
        简体中文 | <a href="/README-en.md" style="margin-left: 5px">English </a>
    </p>
    <p align="center">
        <a href="https://github.com/maillab/cloud-mail/tree/main?tab=MIT-1-ov-file" target="_blank" >
            <img src="https://img.shields.io/badge/license-MIT-green" />
        </a>    
        <a href="https://github.com/maillab/cloud-mail/releases" target="_blank" >
            <img src="https://img.shields.io/github/v/release/maillab/cloud-mail" alt="releases" />
        </a>  
        <a href="https://github.com/maillab/cloud-mail/issues" >
            <img src="https://img.shields.io/github/issues/maillab/cloud-mail" alt="issues" />
        </a>  
        <a href="https://github.com/maillab/cloud-mail/stargazers" target="_blank">
            <img src="https://img.shields.io/github/stars/maillab/cloud-mail" alt="stargazers" />
        </a>  
        <a href="https://github.com/maillab/cloud-mail/forks" target="_blank" >
            <img src="https://img.shields.io/github/forks/maillab/cloud-mail" alt="forks" />
        </a>
    </p>
    <p align="center">
        <a href="https://trendshift.io/repositories/20459" target="_blank" >
            <img src="https://trendshift.io/api/badge/repositories/20459" alt="trendshift" >
        </a>
    </p>
</p>


## 项目简介

只需要一个域名，就可以创建多个不同的邮箱，类似各大邮箱平台，本项目支持署到 Cloudflare Workers ，降低服务器成本，搭建自己的邮箱服务

## 企业员工同步

华易丰盈部署支持由飞书员工身份同步服务自动创建、启用和停用邮箱。员工同步入口使用带时间戳的
HMAC-SHA256 签名并按事件 ID 幂等处理；邮箱地址首次
分配后保持稳定，离职时只禁用账户并撤销会话，不删除历史邮件。

Cloudflare Worker 需要配置：

- 普通变量：`identity_mail_domain`；
- Secret：`IDENTITY_SYNC_SECRET`。

身份同步调用 `POST /api/internal/identity-events`。系统会将飞书员工姓名转换为小写全拼并在
`identity_mail_domain` 下分配邮箱，例如“张三”分配为 `zhangsan@huayimail.com`；发生重名时依次
追加数字 `2`、`3`。邮箱首次分配后保持稳定，不随姓名变化自动修改。

## 子域邮箱路由同步

`email.huayifull.com` 使用 Cloudflare Email Routing 子域收件。Cloudflare 不支持子域 catch-all，
因此系统会在创建、恢复和物理删除邮箱时同步维护“具体地址 → `cloud-mail` Worker”的精确路由；
`huayimail.com` 继续使用原有 catch-all，不受影响。批量导入或同步失败时会撤销本次数据库写入和已完成的路由变更。

部署变量为 `EMAIL_ROUTING_DOMAIN`、`EMAIL_ROUTING_ZONE_ID`、`EMAIL_ROUTING_WORKER`，运行时 Secret 为
`EMAIL_ROUTING_API_TOKEN`。首次部署后手动运行 `Provision email routing token` 工作流；它使用仓库现有的
Cloudflare 管理令牌创建仅限目标区域、仅含 `Email Routing Rules Write` 权限的账户专用令牌，并直接写入
Worker Secret。后续常规部署会保留该 Secret。

网页入口以 `mail.huayifull.com` 为公司主入口，原 `mail.huayimail.com` 暂时保留；两个入口指向同一
Worker，并分别使用各自域名的公司登录回调。邮箱地址仍按 `@huayimail.com` 和
`@email.huayifull.com` 两个邮件域并行存在。

## 店铺邮箱自动开通

OpsPilot 通过 `POST /api/internal/store-mailboxes` 提交 `store_id`（SHEIN 数字店铺 ID）和 `name`。
接口按 `<store_id>@huayimail.com` 创建 SHEIN 专用用户名下的收件箱，重复请求返回原邮箱；
归属用户由 Worker 变量 `store_mailbox_owner` 指定，默认 `shein@huayimail.com`，必须预先创建并启用，
不能配置为管理员。SHEIN 专用用户独立登录管理店铺邮箱，管理员仍通过管理入口管理不同平台。
已有邮箱归属不同或已停用时返回冲突，不覆盖。
Worker 配置独立 Secret `STORE_MAILBOX_SECRET`。请求头 `X-Store-Timestamp` 为 Unix 秒，
`X-Store-Signature` 为该密钥对 `timestamp.body` 的 HMAC-SHA256 小写十六进制摘要，五分钟内有效。
部署工作流从同名 GitHub Secret 配置 Worker。接口成功代表收件箱已建，不代表 SHEIN 已换绑。

## 项目展示

收件箱左侧的邮箱列表支持按邮箱地址、店铺 ID 或名称进行包含匹配搜索。
输入后自动筛选，按回车可立即查询，清空搜索恢复完整列表；点击结果切换收件箱。
查询覆盖当前用户名下所有未删除的邮箱，保留置顶排序和每页 30 条的滚动加载。
`GET /api/account/list` 支持可选参数 `keyword`，与 `accountId`、`lastSort` 分页参数配合使用。

- [在线演示](https://skymail.ink)<br>
- [部署文档](https://doc.skymail.ink)<br>

| ![](/doc/demo/demo1.png) | ![](/doc/demo/demo2.png) |
|-----------------------|-----------------------|
| ![](/doc/demo/demo3.png) | ![](/doc/demo/demo4.png) |




## 功能介绍

- **💰 低成本使用**： 可部署到 Cloudflare Workers 降低服务器成本

- **💻 响应式设计**：响应式布局自动适配PC和大部分手机端浏览器

- **📧 邮件发送**：集成Resend发送邮件，支持群发，内嵌图片和附件发送，发送状态查看

- **🛡️ 管理员功能**：可以对用户，邮件进行管理，RABC权限控制对功能及使用资源限制

- **📦 附件收发**：支持收发附件，使用R2对象存储保存和下载文件

- **🔔 邮件推送**：接收邮件后可以转发到TG机器人或其他服务商邮箱

- **📡 开放API**：支持使用API批量生成用户，多条件查询邮件 

- **🔢 验证码识别**：使用Workers AI，自动识别邮件验证码 

- **📈 数据可视化**：使用ECharts对系统数据详情，用户邮件增长可视化显示

- **🎨 个性化设置**：可以自定义网站标题，登录背景，透明度

- **🤖 人机验证**：集成Turnstile人机验证，防止人机批量注册

- **📜 更多功能**：正在开发中...



## 技术栈

- **平台**：[Cloudflare Workers](https://developers.cloudflare.com/workers/)

- **Web框架**：[Hono](https://hono.dev/)

- **ORM：**[Drizzle](https://orm.drizzle.team/)

- **前端框架**：[Vue3](https://vuejs.org/) 

- **UI框架**：[Element Plus](https://element-plus.org/) 

- **邮件推送：** [Resend](https://resend.com/)

- **缓存**：[Cloudflare KV](https://developers.cloudflare.com/kv/)

- **数据库**：[Cloudflare D1](https://developers.cloudflare.com/d1/)

- **文件存储**：[Cloudflare R2](https://developers.cloudflare.com/r2/)

## 目录结构

```
cloud-mail
├── mail-worker				    # worker后端项目
│   ├── src                  
│   │   ├── api	 			    # api接口层			
│   │   ├── const  			    # 项目常量
│   │   ├── dao                 # 数据访问层
│   │   ├── email			    # 邮件处理接收
│   │   ├── entity			    # 数据库实体
│   │   ├── error			    # 自定义异常
│   │   ├── hono			    # web框架配置、拦截器、全局异常等
│   │   ├── i18n			    # 语言国际化
│   │   ├── init			    # 数据库缓存初始化
│   │   ├── model			    # 响应体数据封装
│   │   ├── security			# 身份权限认证
│   │   ├── service			    # 业务服务层
│   │   ├── template			# 消息模板
│   │   ├── utils			    # 工具类
│   │   └── index.js			# 入口文件
│   ├── pageckge.json			# 项目依赖
│   └── wrangler.toml			# 项目配置
│
├── mail-vue				    # vue前端项目
│   ├── src
│   │   ├── axios 			    # axios配置
│   │   ├── components			# 自定义组件
│   │   ├── echarts			    # echarts组件导入
│   │   ├── i18n			    # 语言国际化
│   │   ├── init			    # 入站初始化
│   │   ├── layout			    # 主体布局组件
│   │   ├── perm			    # 权限认证
│   │   ├── request			    # api接口
│   │   ├── router			    # 路由配置
│   │   ├── store			    # 全局状态管理
│   │   ├── utils			    # 工具类
│   │   ├── views			    # 页面组件
│   │   ├── app.vue			    # 入口组件
│   │   ├── main.js			    # 入口js
│   │   └── style.css			# 全局css
│   ├── package.json			# 项目依赖
└── └── env.release				# 项目配置
```

## 赞助

<a href="https://doc.skymail.ink/support.html" >
<img width="170px" src="./doc/images/support.png" alt="">
</a>

## 许可证

本项目采用 [MIT](LICENSE) 许可证	


## 交流

[Telegram](https://t.me/cloud_mail_tg)



