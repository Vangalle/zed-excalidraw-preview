const phases = {
  checking: ['Excalidraw: Checking existing browsers', 'Looking for a compatible browser to reuse; PNG rendering has not started.'],
  download: ['Excalidraw: Downloading Chromium', 'First-time browser setup (~100–150 MB). PNG rendering has not started.'],
  render: ['Excalidraw: Rendering PNG', 'Browser ready. Rendering the current editor snapshot.'],
  browser: ['Excalidraw: Starting browser preview', 'Preparing the local read-only viewer; no Chromium download is needed.'],
};

export function createPreviewProgress(connection, { controller, showLog, isActive = () => true, isStopping = () => false }) {
  let current;
  let phase;
  const subscriptions = [];
  return {
    async phase(next) {
      if (controller.signal.aborted) throw new Error('Excalidraw preview cancelled.');
      if (next === phase) return;
      const [title, message] = phases[next];
      current?.done();
      current = await connection.window.createWorkDoneProgress();
      subscriptions.push(current.token.onCancellationRequested(() => controller.abort()));
      current.begin(title, undefined, message, true);
      phase = next;
      if (next === 'download') {
        // Zed renders this as a notification. Do not await the user's response:
        // the download and concurrent View Download Log command must continue.
        connection.window.showInformationMessage(
          'Excalidraw first-time setup: no compatible existing browser was found. Downloading Chromium (~100–150 MB); PNG rendering has not started. Future previews will reuse this installation. You can keep working.',
          { title: 'View Download Log' }, { title: 'Cancel download' },
        ).then(action => {
          if (isStopping() || !isActive()) return;
          if (action?.title === 'Cancel download') controller.abort();
          if (action?.title === 'View Download Log') return showLog();
        }).catch(error => connection.console.error(`Excalidraw setup notification: ${error.message}`));
      }
    },
    report(report) {
      if (isStopping()) return;
      connection.console.log(report.message);
      if (report.percentage != null) current?.report(report.percentage, report.message);
      else current?.report(report.message);
    },
    done() {
      for (const subscription of subscriptions) subscription.dispose();
      current?.done();
      current = undefined;
    },
  };
}
