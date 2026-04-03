const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 256, height: 256,
    backgroundColor: '#08080a',
    useContentSize: true,
    frame: false,
  });

  // Use a CSS-drawn 4-point star instead of a text character
  await win.loadFile(path.join(__dirname, 'icon-template.html'));
  await new Promise(r => setTimeout(r, 2000));

  const image = await win.webContents.capturePage();
  const png = image.toPNG();
  fs.writeFileSync(path.join(__dirname, 'icon.png'), png);
  console.log('PNG: ' + png.length + ' bytes');

  const img32 = image.resize({ width: 32, height: 32 });
  const img48 = image.resize({ width: 48, height: 48 });
  const img64 = image.resize({ width: 64, height: 64 });

  fs.writeFileSync(path.join(__dirname, 'icon-32.png'), img32.toPNG());
  fs.writeFileSync(path.join(__dirname, 'icon-48.png'), img48.toPNG());
  fs.writeFileSync(path.join(__dirname, 'icon-64.png'), img64.toPNG());

  console.log('All sizes saved');
  app.quit();
});
