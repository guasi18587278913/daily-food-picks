# Validation

npm run prepare:functions 后跑 tests/source-navigation.test.js、tests/catalog.test.js、tests/frontend.test.js 和定向页面用例。前端交付执行typecheck:mini，包检查核对新共享副本。外部调用默认全替身；真实微信跳转按用户确认记录，不能用模拟器成功回调替代正文展示。

真实注册必须先获得“笔记编号↔官方短链接”的对应关系，并确认笔记已在工作台发布。当前这项输入待提供。未完成绑定前不宣称正式列表已经可直达。
