/*
 * 加载项入口（由 index.html 引入，WPS 启动时自动执行）
 * 用 document.write 串联脚本，避免 ES module 在 file:// 下的加载限制。
 */
document.write('<script type="text/javascript" src="./js/utils.js"><\/script>');
document.write('<script type="text/javascript" src="./js/aes.js"><\/script>');
document.write('<script type="text/javascript" src="./js/engine.js"><\/script>');
document.write('<script type="text/javascript" src="./js/ribbon.js"><\/script>');
