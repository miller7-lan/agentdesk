(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  for (let attempt = 0; !window.__group && attempt < 40; attempt++) await wait(50);
  if (!window.__group) throw new Error('群聊尚未初始化');
  window.__boot?.skip();
  const project = window.__desk.D.projects.find(({ live }) => !live);
  if (project && window.__group.createGroup(project.id)) window.__desk.openGroup(project.id);
  await wait(300);
  await window.desk.test.shot('group');
  window.desk.test.done();
})();
