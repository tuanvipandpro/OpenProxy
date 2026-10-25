using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using System.Reflection;
using System.Runtime.InteropServices;

[assembly: AssemblyTitle("OpenProxy")]
[assembly: AssemblyDescription("Local ChatGPT proxy with manual account switching")]
[assembly: AssemblyVersion("0.6.1.0")]
[assembly: AssemblyFileVersion("0.6.1.0")]

namespace OpenProxyDesktop {
  static class Program {
    [STAThread]
    static void Main(string[] args) {
      for (int i = 0; i + 1 < args.Length; i++) if (args[i] == "--home") Environment.SetEnvironmentVariable("OPENPROXY_HOME", Path.GetFullPath(args[++i]));
      string state = Environment.GetEnvironmentVariable("OPENPROXY_HOME") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "OpenProxy");
      string suffix;
      using (var sha = SHA256.Create()) suffix = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(state.ToUpperInvariant()))).Replace("-", "").Substring(0, 24);
      bool first;
      using (var mutex = new Mutex(true, "Local\\OpenProxy.Desktop." + suffix, out first)) {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        if (!first) { NoticeDialog.ShowMessage(null,"OpenProxy is already open. Please use the existing window.","OpenProxy"); return; }
        Application.Run(new StartupContext(state));
        mutex.ReleaseMutex();
      }
    }
  }

  class DarkForm : Form {
    protected DarkForm() { SetStyle(ControlStyles.OptimizedDoubleBuffer | ControlStyles.AllPaintingInWmPaint | ControlStyles.ResizeRedraw,true); }
    [DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);
    protected override void OnHandleCreated(EventArgs e) {
      base.OnHandleCreated(e);
      try { int enabled = 1; if (DwmSetWindowAttribute(Handle,20,ref enabled,4) != 0) DwmSetWindowAttribute(Handle,19,ref enabled,4); } catch { }
    }
    protected override void OnSizeChanged(EventArgs e) { base.OnSizeChanged(e); Invalidate(true); }
  }

  sealed class StepProgress : Control {
    int value;
    public int Value { get { return value; } set { this.value = Math.Max(0,Math.Min(5,value)); Invalidate(); } }
    public StepProgress() { SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw,true); AccessibleName = "Startup progress"; }
    protected override void OnPaint(PaintEventArgs e) {
      using (var track = new SolidBrush(Theme.Line)) e.Graphics.FillRectangle(track,ClientRectangle);
      using (var fill = new SolidBrush(Theme.Accent)) e.Graphics.FillRectangle(fill,0,0,Width * value / 5,Height);
    }
  }

  sealed class LoadingWindow : DarkForm {
    readonly Label stage, elapsed;
    readonly StepProgress progress;
    readonly Button retry;
    readonly Stopwatch watch = Stopwatch.StartNew();
    readonly System.Windows.Forms.Timer clock = new System.Windows.Forms.Timer { Interval = 200 };
    int step;
    public event EventHandler RetryRequested;
    public double ElapsedMilliseconds { get { return watch.Elapsed.TotalMilliseconds; } }
    public LoadingWindow() {
      Text = "Starting OpenProxy"; ClientSize = new Size(460,230); FormBorderStyle = FormBorderStyle.FixedDialog;
      MaximizeBox = false; MinimizeBox = false; StartPosition = FormStartPosition.CenterScreen;
      BackColor = Theme.Card; ForeColor = Theme.Ink; AutoScaleMode = AutoScaleMode.Dpi; Font = new Font("Segoe UI",10);
      Theme.Label(this,"OpenProxy",24,20,400,36,21,true,Theme.Ink);
      stage = Theme.Label(this,"Preparing the application…",26,73,405,44,10,false,Theme.Ink);
      progress = new StepProgress { Location = new Point(26,124), Size = new Size(405,12) };
      Controls.Add(progress);
      elapsed = Theme.Label(this,"",26,151,280,44,9,false,Theme.Muted);
      retry = new ActionButton("Retry",false) { Location = new Point(328,171), Size = new Size(104,34), Visible = false };
      retry.Click += delegate { if (RetryRequested != null) RetryRequested(this,EventArgs.Empty); }; Controls.Add(retry);
      clock.Tick += delegate { UpdateElapsed(); }; clock.Start();
      FormClosed += delegate { clock.Dispose(); };
      SetStep(1,"Preparing the application…");
    }
    public void Restart() { watch.Restart(); step = 0; retry.Visible = false; clock.Start(); SetStep(1,"Preparing the application…"); }
    public void SetStep(int value, string text) {
      if (value < step) return;
      step = value; stage.Text = text; progress.Value = Math.Min(5,value); UpdateElapsed();
    }
    void UpdateElapsed() { elapsed.Text = "Step " + step + " of 5  ·  " + watch.Elapsed.TotalSeconds.ToString("0.0") + " s"; }
    public void Failed(string message) { clock.Stop(); stage.Text = "Could not start OpenProxy. " + message; retry.Visible = true; }
    public void ShowClosing() { retry.Visible = false; stage.Text = "Closing… Waiting for startup to finish safely."; }
  }

  sealed class StartupContext : ApplicationContext {
    readonly string root;
    readonly LoadingWindow loading = new LoadingWindow();
    Backend candidate;
    bool initializing = true, closing, allowLoadingClose;
    public StartupContext(string stateRoot) {
      root = stateRoot; MainForm = loading;
      loading.Shown += delegate { loading.Refresh(); loading.BeginInvoke(new Action(async delegate { await Start(); })); };
      loading.RetryRequested += async delegate { if (!initializing) { initializing = true; loading.Restart(); await Start(); } };
      loading.FormClosing += delegate(object sender, FormClosingEventArgs e) {
        if (allowLoadingClose || !initializing) return;
        e.Cancel = true; closing = true; loading.ShowClosing();
      };
      loading.Show();
    }
    void Report(string stage) {
      try {
        loading.BeginInvoke(new Action(delegate {
          if (loading.IsDisposed || closing || !initializing) return;
          switch (stage) {
            case "modules": loading.SetStep(2,"Loading local services…"); break;
            case "localState": loading.SetStep(3,"Reading local settings…"); break;
            case "ready": loading.SetStep(4,"Loading account information…"); break;
          }
        }));
      } catch (InvalidOperationException) { }
    }
    async Task Start() {
      Exception startupError = null;
      try {
        loading.SetStep(2,"Starting the local backend…");
        // Process.Start may block on Windows process initialization. Keep it
        // off the UI thread so the first window and progress remain responsive.
        candidate = await Task.Run(() => new Backend(root,Report));
        if (!closing) {
          var state = await candidate.Call("status");
          if (!closing) {
            loading.SetStep(5,"Opening your workspace…"); loading.Refresh();
            var window = new MainWindow(candidate,state);
            window.SetStartupTime(loading.ElapsedMilliseconds);
            MainForm = window;
            window.Show(); candidate = null;
            allowLoadingClose = true; loading.Close();
          }
        }
      } catch (Exception error) {
        startupError = error;
        if (MainForm != loading) { var failed = MainForm; MainForm = loading; failed.Dispose(); }
      }
      if (candidate != null) { var unused = candidate; candidate = null; await Task.Run(() => unused.Dispose()); }
      initializing = false;
      if (closing) { allowLoadingClose = true; loading.Close(); }
      else if (startupError != null) loading.Failed(startupError.Message);
    }
  }

  sealed class Backend : IDisposable {
    readonly Process process;
    readonly JavaScriptSerializer json = new JavaScriptSerializer();
    readonly Dictionary<int, TaskCompletionSource<Dictionary<string, object>>> pending = new Dictionary<int, TaskCompletionSource<Dictionary<string, object>>>();
    readonly object gate = new object();
    readonly Action<string> progress;
    string failure;
    int nextId;
    public Backend(string root, Action<string> startupProgress) {
      progress = startupProgress;
      string resources = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "resources");
      var info = new ProcessStartInfo(Path.Combine(resources, "runtime", "node.exe"), Quote(Path.Combine(resources, "openproxy", "desktop-host.mjs")));
      info.UseShellExecute = false; info.CreateNoWindow = true;
      info.RedirectStandardInput = true; info.RedirectStandardOutput = true; info.RedirectStandardError = true;
      info.StandardOutputEncoding = Encoding.UTF8; info.StandardErrorEncoding = Encoding.UTF8;
      info.WorkingDirectory = resources;
      info.EnvironmentVariables["OPENPROXY_HOME"] = root;
      info.EnvironmentVariables["OPENPROXY_ENGINE"] = Path.Combine(resources, "engine", "claude-code-proxy.exe");
      process = new Process { StartInfo = info, EnableRaisingEvents = true };
      process.OutputDataReceived += OnLine;
      process.ErrorDataReceived += delegate { /* Never surface unfiltered engine diagnostics. */ };
      process.Exited += delegate { FailPending("The backend stopped. Close and reopen OpenProxy to try again."); };
      try {
        process.Start(); process.StandardInput.AutoFlush = true;
        process.BeginOutputReadLine(); process.BeginErrorReadLine();
      } catch { try { if (!process.HasExited) process.Kill(); } catch { } process.Dispose(); throw; }
    }
    public static string Quote(string value) { return "\"" + value.Replace("\"", "\\\"") + "\""; }
    void OnLine(object sender, DataReceivedEventArgs e) {
      if (e.Data == null) return;
      try {
        var message = json.DeserializeObject(e.Data) as Dictionary<string, object>;
        if (message == null) return;
        if (message.ContainsKey("event") && Convert.ToString(message["event"]) == "startup") {
          if (progress != null && message.ContainsKey("stage")) progress(Convert.ToString(message["stage"]));
          return;
        }
        if (message.ContainsKey("event") && Convert.ToString(message["event"]) == "fatal") { FailPending(Convert.ToString(message["error"])); return; }
        if (!message.ContainsKey("id") || message["id"] == null) return;
        TaskCompletionSource<Dictionary<string, object>> completion;
        lock (gate) { int id = Convert.ToInt32(message["id"]); if (!pending.TryGetValue(id, out completion)) return; pending.Remove(id); }
        if (message.ContainsKey("error")) completion.TrySetException(new Exception(Convert.ToString(message["error"])));
        else completion.TrySetResult((Dictionary<string, object>)message["result"]);
      } catch { FailPending("Could not read the application response."); }
    }
    void FailPending(string error) {
      lock (gate) { if (failure == null) failure = error; foreach (var item in pending.Values) item.TrySetException(new Exception(failure)); pending.Clear(); }
    }
    public async Task<Dictionary<string, object>> Call(string method, object arguments = null) {
      var completion = new TaskCompletionSource<Dictionary<string, object>>();
      int id;
      lock (gate) {
        if (failure != null) throw new Exception(failure);
        if (process.HasExited) throw new Exception("The backend stopped. Please reopen the application.");
        id = ++nextId; pending[id] = completion;
        process.StandardInput.WriteLine(json.Serialize(new { id = id, method = method, args = arguments ?? new { } }));
      }
      if (await Task.WhenAny(completion.Task, Task.Delay(15000)) != completion.Task) {
        lock (gate) pending.Remove(id);
        throw new Exception("The operation has not responded. Check its status before trying again.");
      }
      return await completion.Task;
    }
    public void Dispose() {
      try { process.StandardInput.Close(); if (!process.WaitForExit(2500)) process.Kill(); } catch { }
      process.Dispose();
    }
  }

  static class Theme {
    public static readonly Color Ink = Color.FromArgb(234,235,239);
    public static readonly Color Muted = Color.FromArgb(163,166,175);
    public static readonly Color Accent = Color.FromArgb(183,203,220);
    public static readonly Color Canvas = Color.FromArgb(20,20,23);
    public static readonly Color Card = Color.FromArgb(28,29,33);
    public static readonly Color Line = Color.FromArgb(48,50,57);
    public static readonly Color Selected = Color.FromArgb(36,41,48);
    public static readonly Color ButtonText = Color.FromArgb(17,32,52);
    public static GraphicsPath Round(Rectangle rectangle, int radius) {
      var p = new GraphicsPath(); int d = radius * 2;
      p.AddArc(rectangle.X, rectangle.Y, d, d, 180, 90); p.AddArc(rectangle.Right - d, rectangle.Y, d, d, 270, 90);
      p.AddArc(rectangle.Right - d, rectangle.Bottom - d, d, d, 0, 90); p.AddArc(rectangle.X, rectangle.Bottom - d, d, d, 90, 90); p.CloseFigure(); return p;
    }
    public static Label Label(Control parent, string text, int x, int y, int w, int h, float size, bool bold, Color color) {
      var label = new Label { Text = text, Location = new Point(x,y), Size = new Size(w,h), ForeColor = color, BackColor = Color.Transparent,
        Font = new Font("Segoe UI", size, bold ? FontStyle.Bold : FontStyle.Regular), AutoEllipsis = true };
      parent.Controls.Add(label); return label;
    }
  }
  sealed class MenuColors : ProfessionalColorTable {
    public override Color ToolStripDropDownBackground { get { return Theme.Card; } }
    public override Color ImageMarginGradientBegin { get { return Theme.Card; } }
    public override Color ImageMarginGradientMiddle { get { return Theme.Card; } }
    public override Color ImageMarginGradientEnd { get { return Theme.Card; } }
    public override Color MenuItemSelected { get { return Theme.Selected; } }
    public override Color MenuItemBorder { get { return Theme.Line; } }
    public override Color MenuBorder { get { return Theme.Line; } }
  }
  class Surface : Panel {
    public Surface() {
      SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw,true);
      BackColor = Theme.Card;
    }
    protected override void OnSizeChanged(EventArgs e) { base.OnSizeChanged(e); Invalidate(true); }
    protected override void OnPaintBackground(PaintEventArgs e) {
      // FillRectangle respects the paint clip, including translated parent
      // painting requested by transparent child labels. Never clear that HDC.
      using (var background = new SolidBrush(Parent == null ? Theme.Canvas : Parent.BackColor)) e.Graphics.FillRectangle(background,ClientRectangle);
      if (Width < 2 || Height < 2) return;
      e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
      using (var path = Theme.Round(new Rectangle(0,0,Width - 1,Height - 1),12))
      using (var fill = new SolidBrush(BackColor)) e.Graphics.FillPath(fill,path);
    }
    protected override void OnPaint(PaintEventArgs e) {
      if (Width < 2 || Height < 2) return;
      e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
      using (var path = Theme.Round(new Rectangle(0,0,Width - 1, Height - 1), 12)) {
        using (var pen = new Pen(Theme.Line)) e.Graphics.DrawPath(pen,path);
      }
      base.OnPaint(e);
    }
  }
  class ActionButton : Button {
    readonly bool primary;
    bool hover;
    public ActionButton(string text, bool primary) {
      SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw,true);
      this.primary = primary;
      Text = text; AccessibleName = text; Cursor = Cursors.Hand; FlatStyle = FlatStyle.Flat;
      Font = new Font("Segoe UI", 10, FontStyle.Bold); Height = 38;
      BackColor = primary ? Theme.Accent : Theme.Card; ForeColor = primary ? Theme.ButtonText : Theme.Ink;
      FlatAppearance.BorderColor = primary ? Theme.Accent : Theme.Line; FlatAppearance.BorderSize = 1;
      FlatAppearance.MouseOverBackColor = primary ? Color.FromArgb(164,198,253) : Theme.Selected;
      UseVisualStyleBackColor = false;
    }
    protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { hover = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnEnabledChanged(EventArgs e) { Invalidate(); base.OnEnabledChanged(e); }
    protected override void OnPaintBackground(PaintEventArgs e) {
      using (var background = new SolidBrush(Parent == null ? Theme.Card : Parent.BackColor)) e.Graphics.FillRectangle(background,ClientRectangle);
    }
    protected override void OnPaint(PaintEventArgs e) {
      if (Width < 2 || Height < 2) return;
      e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
      Color fill = !Enabled ? Theme.Card : primary ? (hover ? Color.FromArgb(205,220,232) : Theme.Accent) : hover ? Theme.Selected : Theme.Card;
      Color text = !Enabled ? Theme.Muted : primary ? Theme.ButtonText : Theme.Ink;
      using (var path = Theme.Round(new Rectangle(0,0,Width - 1,Height - 1),6)) {
        using (var brush = new SolidBrush(fill)) e.Graphics.FillPath(brush,path);
        using (var pen = new Pen(primary && Enabled ? Theme.Accent : Theme.Line)) e.Graphics.DrawPath(pen,path);
      }
      TextRenderer.DrawText(e.Graphics,Text,Font,ClientRectangle,text,TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
      if (Focused && ShowFocusCues) ControlPaint.DrawFocusRectangle(e.Graphics,Rectangle.Inflate(ClientRectangle,-5,-5),text,fill);
    }
  }

  sealed class MainWindow : DarkForm {
    Backend backend;
    readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer { Interval = 1400 };
    Surface connection, accounts, activity;
    Label heading, subtitle, endpoint, badge, recent, accountSummary;
    ActionButton toggle, gettingStarted, add, settings;
    readonly ToolTip metadataTips = new ToolTip { AutoPopDelay = 20000, InitialDelay = 400, BackColor = Theme.Card, ForeColor = Theme.Ink, OwnerDraw = true };
    FlowLayoutPanel rows;
    Dictionary<string, object> current;
    ContextMenuStrip accountMenu;
    string rowSignature = "";
    bool busy, polling, allowClose, closing;
    public MainWindow(Backend readyBackend, Dictionary<string, object> initialState) {
      backend = readyBackend; Text = "OpenProxy"; ClientSize = new Size(960, 760); MinimumSize = new Size(940, 755);
      StartPosition = FormStartPosition.CenterScreen; BackColor = Theme.Canvas; AutoScaleMode = AutoScaleMode.Dpi;
      Font = new Font("Segoe UI", 10); DoubleBuffered = true;
      metadataTips.Draw += delegate(object sender, DrawToolTipEventArgs e) {
        using (var fill = new SolidBrush(Theme.Card)) e.Graphics.FillRectangle(fill,e.Bounds);
        using (var border = new Pen(Theme.Line)) e.Graphics.DrawRectangle(border,0,0,e.Bounds.Width - 1,e.Bounds.Height - 1);
        TextRenderer.DrawText(e.Graphics,e.ToolTipText,e.Font,Rectangle.Inflate(e.Bounds,-3,-2),Theme.Ink,TextFormatFlags.WordBreak);
      };
      using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("OpenProxy.Icon")) {
        if (stream != null) using (var icon = new Icon(stream)) Icon = (Icon)icon.Clone();
      }
      SuspendLayout();
      BuildUi();
      ResumeLayout(true);
      Render(initialState);
      Shown += delegate { timer.Start(); };
      timer.Tick += async delegate { if (!busy && !polling && !closing) await RefreshState(); };
      FormClosing += async delegate(object sender, FormClosingEventArgs e) {
        if (allowClose) return;
        e.Cancel = true; if (closing) return;
        closing = true; timer.Stop(); toggle.Enabled = false; toggle.Text = "Closing…";
        try { if (backend != null) await backend.Call("shutdown"); } catch { }
        if (backend != null) await Task.Run(() => backend.Dispose());
        allowClose = true; Close();
      };
    }
    public void SetStartupTime(double milliseconds) {
      recent.Text = "Ready in " + (milliseconds / 1000).ToString("0.0") + " s. Start the proxy whenever you are ready.";
    }
    void BuildUi() {
      var layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(24), ColumnCount = 1, RowCount = 9, BackColor = Theme.Canvas };
      layout.SuspendLayout();
      layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));
      foreach (int height in new[] { 64,16,164,16 }) layout.RowStyles.Add(new RowStyle(SizeType.Absolute,height));
      layout.RowStyles.Add(new RowStyle(SizeType.Percent,100));
      foreach (int height in new[] { 16,92,16,38 }) layout.RowStyles.Add(new RowStyle(SizeType.Absolute,height));
      Controls.Add(layout);
      var header = new Panel { Dock = DockStyle.Fill, Margin = new Padding(0) }; layout.Controls.Add(header,0,0);
      var mark = new Label { Text = "OP", ForeColor = Theme.Accent, BackColor = Theme.Card, Font = new Font("Segoe UI",13,FontStyle.Bold), TextAlign = ContentAlignment.MiddleCenter, Location = new Point(0,6), Size = new Size(44,44) }; header.Controls.Add(mark);
      Theme.Label(header,"OpenProxy",60,1,330,33,20,true,Theme.Ink);
      Theme.Label(header,"Your accounts. One local endpoint.",62,36,400,22,9.5f,false,Theme.Muted);
      badge = Theme.Label(header,"●  STOPPED",header.Width - 170,19,170,24,9.5f,true,Theme.Muted); badge.TextAlign = ContentAlignment.MiddleRight; badge.Anchor = AnchorStyles.Top | AnchorStyles.Right;

      connection = new Surface { Dock = DockStyle.Fill, Margin = new Padding(0), Padding = new Padding(20) }; layout.Controls.Add(connection,0,2);
      var connectionGrid = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 1, BackColor = Theme.Card, Margin = new Padding(0) };
      connectionGrid.SuspendLayout();
      connectionGrid.RowStyles.Add(new RowStyle(SizeType.Percent,100));
      connectionGrid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100)); connectionGrid.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,172)); connection.Controls.Add(connectionGrid);
      var details = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 4, Margin = new Padding(0,0,20,0) };
      details.SuspendLayout();
      foreach (int height in new[] { 22,36,27,36 }) details.RowStyles.Add(new RowStyle(SizeType.Absolute,height));
      details.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100)); connectionGrid.Controls.Add(details,0,0);
      var caption = new Label { Text = "LOCAL CONNECTION", Dock = DockStyle.Fill, ForeColor = Theme.Muted, Font = new Font("Segoe UI",8.5f,FontStyle.Bold) }; details.Controls.Add(caption,0,0);
      heading = new Label { Text = "Proxy is stopped", Dock = DockStyle.Fill, ForeColor = Theme.Ink, Font = new Font("Segoe UI",20,FontStyle.Bold), AutoEllipsis = true }; details.Controls.Add(heading,0,1);
      subtitle = new Label { Text = "Start when needed. Close the app to stop.", Dock = DockStyle.Fill, ForeColor = Theme.Muted, Font = new Font("Segoe UI",9.5f), AutoEllipsis = true }; details.Controls.Add(subtitle,0,2);
      var address = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.LeftToRight, WrapContents = false, Margin = new Padding(0) }; details.Controls.Add(address,0,3);
      endpoint = new Label { Text = "http://127.0.0.1:1234", Size = new Size(260,32), Font = new Font("Consolas",10.5f), ForeColor = Theme.Ink, TextAlign = ContentAlignment.MiddleLeft, Margin = new Padding(0,0,12,0) }; address.Controls.Add(endpoint);
      var copy = new ActionButton("Copy URL",false) { Size = new Size(96,32), Margin = new Padding(0) };
      copy.Click += delegate { try { Clipboard.SetText(endpoint.Text); recent.Text = "Proxy address copied."; } catch { } }; address.Controls.Add(copy);
      var connectionActions = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 3, Margin = new Padding(0,9,0,0) };
      connectionActions.SuspendLayout();
      connectionActions.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));
      foreach (int height in new[] { 42,12,38 }) connectionActions.RowStyles.Add(new RowStyle(SizeType.Absolute,height)); connectionGrid.Controls.Add(connectionActions,1,0);
      toggle = new ActionButton("Start proxy",true) { Dock = DockStyle.Fill, Margin = new Padding(0), Enabled = false };
      toggle.Click += async delegate { if (current != null) await Act(Get(current,"login") != null ? "cancelLogin" : Bool(current,"running") ? "stop" : "start", null); }; connectionActions.Controls.Add(toggle,0,0);
      gettingStarted = new ActionButton("Getting started",false) { Dock = DockStyle.Fill, Margin = new Padding(0), Enabled = false };
      gettingStarted.Click += async delegate {
        if (backend == null || busy || closing) return;
        gettingStarted.Enabled = false;
        try {
          var guide = await backend.Call("gettingStarted");
          using (var dialog = new GettingStartedDialog(guide,backend)) dialog.ShowDialog(this);
        } catch (Exception error) { ShowError(error.Message); }
        finally { gettingStarted.Enabled = !closing && !busy; }
      }; connectionActions.Controls.Add(gettingStarted,0,2);

      accounts = new Surface { Dock = DockStyle.Fill, Margin = new Padding(0), Padding = new Padding(12) }; layout.Controls.Add(accounts,0,4);
      var accountGrid = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 2, Margin = new Padding(0), BackColor = Theme.Card };
      accountGrid.SuspendLayout();
      accountGrid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100)); accountGrid.RowStyles.Add(new RowStyle(SizeType.Absolute,52)); accountGrid.RowStyles.Add(new RowStyle(SizeType.Percent,100)); accounts.Controls.Add(accountGrid);
      var accountHeader = new Panel { Dock = DockStyle.Fill, Margin = new Padding(0) }; accountGrid.Controls.Add(accountHeader,0,0);
      Theme.Label(accountHeader,"Accounts",0,0,250,26,14,true,Theme.Ink);
      accountSummary = Theme.Label(accountHeader,"Choose an account for new requests.",1,29,550,20,9,false,Theme.Muted);
      add = new ActionButton("+ Add account",false) { Location = new Point(accountHeader.Width - 160,3), Size = new Size(160,36), Anchor = AnchorStyles.Top | AnchorStyles.Right, Enabled = false };
      add.Click += delegate { AddMenu(); }; accountHeader.Controls.Add(add);
      rows = new FlowLayoutPanel { Dock = DockStyle.Fill, Margin = new Padding(0), AutoScroll = true, FlowDirection = FlowDirection.TopDown, WrapContents = false, BackColor = Theme.Card }; accountGrid.Controls.Add(rows,0,1);
      rows.SizeChanged += delegate { foreach (Control row in rows.Controls) row.Width = Math.Max(100,rows.ClientSize.Width - (rows.VerticalScroll.Visible ? SystemInformation.VerticalScrollBarWidth + 2 : 2)); };

      activity = new Surface { Dock = DockStyle.Fill, Margin = new Padding(0), Padding = new Padding(18,12,18,12) }; layout.Controls.Add(activity,0,6);
      var activityGrid = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 2, Margin = new Padding(0), BackColor = Theme.Card };
      activityGrid.SuspendLayout();
      activityGrid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100)); activityGrid.RowStyles.Add(new RowStyle(SizeType.Absolute,25)); activityGrid.RowStyles.Add(new RowStyle(SizeType.Percent,100)); activity.Controls.Add(activityGrid);
      activityGrid.Controls.Add(new Label { Text = "Recent activity", Dock = DockStyle.Fill, Font = new Font("Segoe UI",10,FontStyle.Bold), ForeColor = Theme.Ink },0,0);
      recent = new Label { Text = "Start the proxy whenever you are ready.", Dock = DockStyle.Fill, Font = new Font("Segoe UI",9), ForeColor = Theme.Muted, AutoEllipsis = true }; activityGrid.Controls.Add(recent,0,1);
      var footer = new Panel { Dock = DockStyle.Fill, Margin = new Padding(0) }; layout.Controls.Add(footer,0,8);
      Theme.Label(footer,"Local to this computer  ·  Manual account switching",0,10,620,24,8.8f,false,Theme.Muted);
      settings = new ActionButton("Settings",false) { Location = new Point(footer.Width - 106,0), Size = new Size(106,36), Anchor = AnchorStyles.Top | AnchorStyles.Right, Enabled = false };
      settings.Click += async delegate {
        if (current == null) return;
        using (var dialog = new SettingsDialog(current)) {
          if (dialog.ShowDialog(this) == DialogResult.OK) await Act("preferences", dialog.Values);
        }
      }; footer.Controls.Add(settings);
      details.ResumeLayout(true); connectionActions.ResumeLayout(true); connectionGrid.ResumeLayout(true);
      accountGrid.ResumeLayout(true); activityGrid.ResumeLayout(true); layout.ResumeLayout(true);
    }
    async Task RefreshState() {
      if (backend == null || polling) return;
      polling = true;
      try { Render(await backend.Call("status")); }
      catch (Exception error) { recent.Text = Friendly(error.Message); toggle.Enabled = false; gettingStarted.Enabled = false; }
      finally { polling = false; }
    }
    async Task Act(string method, object arguments) {
      if (busy || backend == null || closing) return;
      busy = true; EnableActions(false);
      try { Render(await backend.Call(method, arguments)); }
      catch (Exception error) { ShowError(error.Message); }
      finally { busy = false; if (current != null) Render(current); }
    }
    void EnableActions(bool enabled) { toggle.Enabled = enabled; add.Enabled = enabled; gettingStarted.Enabled = enabled; settings.Enabled = enabled; rows.Enabled = enabled; }
    void Render(Dictionary<string, object> state) {
      current = state;
      bool running = Bool(state,"running"), owned = Bool(state,"owned"), loggingIn = Get(state,"login") != null;
      string selected = Str(state,"active");
      badge.Text = running ? "●  RUNNING" : loggingIn ? "●  SIGNING IN" : "●  STOPPED";
      badge.ForeColor = running ? Theme.Accent : Theme.Muted;
      heading.Text = running ? "Proxy is running" : loggingIn ? "Waiting for browser sign-in" : "Proxy is stopped";
      subtitle.Text = loggingIn ? "Complete sign-in in your browser to continue." : running ? (selected == "" ? "No active account. Enable and select an account to resume." : "Active account: " + selected) + (owned ? "" : " · Started from CLI") : "Start when needed. Close the app to stop.";
      endpoint.Text = Str(state,"endpoint");
      toggle.Text = loggingIn ? "Cancel sign-in" : running ? "Stop proxy" : "Start proxy";
      toggle.Enabled = !busy && (loggingIn || (!running || owned)) && Bool(state,"engineReady");
      gettingStarted.Enabled = !busy && !closing;
      add.Enabled = !busy && !loggingIn;
      settings.Enabled = !busy && !loggingIn;
      rows.Enabled = !busy && !loggingIn;
      object[] items = Get(state,"accounts") as object[] ?? new object[0];
      accountSummary.Text = items.Length == 0 ? "Link an existing Codex login or sign in to ChatGPT to get started." : "New requests use your selection. Running requests keep their account.";
      string signature = selected + ":" + running + ":" + loggingIn + ":" + new JavaScriptSerializer().Serialize(items);
      if (signature != rowSignature) {
        rowSignature = signature; rows.SuspendLayout();
        foreach (Control control in rows.Controls.Cast<Control>().ToArray()) control.Dispose();
        if (items.Length == 0) Theme.Label(rows,"No accounts yet. Click “+ Add account” above to get started.",12,10,760,60,11,false,Theme.Muted);
        foreach (Dictionary<string, object> item in items) AddAccountRow(item, selected, running, loggingIn);
        rows.ResumeLayout();
      }
      object[] events = Get(state,"events") as object[] ?? new object[0];
      if (events.Length > 0) {
        var lines = new List<string>();
        foreach (Dictionary<string, object> entry in events.Skip(Math.Max(0, events.Length - 2))) {
          DateTime time; string stamp = DateTime.TryParse(Str(entry,"time"), out time) ? time.ToLocalTime().ToString("HH:mm") : "";
          lines.Add(stamp + "   " + Str(entry,"message"));
        }
        recent.Text = string.Join(Environment.NewLine, lines);
      }
    }
    void AddAccountRow(Dictionary<string, object> item, string selected, bool running, bool loggingIn) {
      string name = Str(item,"name"), status = Str(item,"status"); bool active = name == selected, enabled = Bool(item,"enabled");
      var row = new Panel { Width = rows.ClientSize.Width - (rows.VerticalScroll.Visible ? SystemInformation.VerticalScrollBarWidth + 2 : 2), Height = 102, BackColor = active ? Theme.Selected : enabled ? Theme.Card : Theme.Canvas, Margin = new Padding(0,0,0,6) };
      if (active) row.Controls.Add(new Panel { Dock = DockStyle.Left, Width = 2, BackColor = Theme.Accent });
      var avatar = Theme.Label(row,name.Substring(0,1).ToUpperInvariant(),13,12,38,38,14,true,active ? Theme.Accent : Theme.Muted); avatar.TextAlign = ContentAlignment.MiddleCenter;
      var nameLabel = Theme.Label(row,name + (!enabled ? "  ·  Disabled" : ""),63,8,row.Width - 375,24,10.5f,true,Theme.Ink); nameLabel.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
      var subscription = Get(item,"subscription") as Dictionary<string, object>;
      string plan = Str(subscription,"plan"), source = Str(subscription,"planSource");
      if (plan == "" || plan == "unknown") plan = "Unknown";
      else if (source == "token") plan += " (unverified token hint)";
      var planLabel = Theme.Label(row,"Plan: " + plan + "  ·  Auth: " + StatusText(status) + " (local)",64,33,row.Width - 82,21,8.8f,false,Theme.Muted); planLabel.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
      string quota = QuotaText(subscription);
      var quotaLabel = Theme.Label(row,quota,64,54,row.Width - 82,21,8.8f,false,Theme.Muted);
      quotaLabel.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
      metadataTips.SetToolTip(quotaLabel,quota);
      string check = Str(subscription,"checkedAt"); DateTime checkedAt;
      check = DateTime.TryParse(check,out checkedAt) ? checkedAt.ToLocalTime().ToString("MM-dd HH:mm") : "Never";
      string warning = Bool(subscription,"stale") ? " · Stale/unverified" : "";
      string error = Str(subscription,"error");
      if (error != "") warning += " · " + error.Replace('_',' ');
      var billingLabel = Theme.Label(row,"Billing: Unknown  ·  Checked: " + check + warning,64,75,row.Width - 82,21,8.5f,false,Theme.Muted);
      billingLabel.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
      metadataTips.SetToolTip(billingLabel,"The usage API does not establish renewal/cancellation status. Last successful check: " + (Str(subscription,"lastSuccessAt") == "" ? "Never" : Str(subscription,"lastSuccessAt")));
      bool needsLogin = Str(item,"mode") == "owned" && (status == "needs-login" || status == "unavailable" || status == "expired");
      var button = new ActionButton(needsLogin ? "Sign in" : active ? "Active" : "Use account", false) { Location = new Point(row.Width - 312,8), Size = new Size(96,30), AccessibleName = (needsLogin ? "Sign in to " : "Use account ") + name };
      button.Font = new Font("Segoe UI",9,FontStyle.Bold);
      button.Anchor = AnchorStyles.Top | AnchorStyles.Right;
      button.Enabled = enabled && !loggingIn && (needsLogin ? !running : !active && (status == "ready" || status == "refresh-on-request"));
      button.Click += async delegate { await Act(needsLogin ? "login" : "select", new { name = name }); };
      var enable = new ActionButton(enabled ? "Disable" : "Enable",false) { Location = new Point(row.Width - 208,8), Size = new Size(96,30), AccessibleName = (enabled ? "Disable " : "Enable ") + name };
      enable.Font = new Font("Segoe UI",9,FontStyle.Bold); enable.Enabled = !loggingIn;
      enable.Anchor = AnchorStyles.Top | AnchorStyles.Right;
      enable.Click += async delegate { await Act("enabled",new { name = name, enabled = !enabled }); };
      var refresh = new ActionButton("Refresh",false) { Location = new Point(row.Width - 104,8), Size = new Size(96,30), AccessibleName = "Refresh subscription " + name };
      refresh.Font = new Font("Segoe UI",9,FontStyle.Bold); refresh.Enabled = enabled && !loggingIn;
      refresh.Anchor = AnchorStyles.Top | AnchorStyles.Right;
      refresh.Click += async delegate { await Act("refreshSubscription",new { name = name }); };
      if (active) {
        var selectedLabel = Theme.Label(row,"Selected",row.Width - 312,8,96,30,9,true,Theme.Accent); selectedLabel.TextAlign = ContentAlignment.MiddleCenter; selectedLabel.Anchor = AnchorStyles.Top | AnchorStyles.Right;
        button.Dispose();
      } else row.Controls.Add(button);
      row.Controls.Add(enable); row.Controls.Add(refresh); rows.Controls.Add(row);
    }
    static string QuotaText(Dictionary<string, object> subscription) {
      string state = Str(subscription,"usageStatus");
      string text = "Quota: " + (state == "available" ? "Available" : state == "limited" ? "Limit reached" : "Unknown");
      object[] windows = Get(subscription,"windows") as object[] ?? new object[0];
      foreach (Dictionary<string, object> window in windows.Take(2)) {
        object percent = Get(window,"usedPercent"), reset = Get(window,"resetsAt");
        if (percent != null) text += " · " + Str(window,"name") + " " + Convert.ToString(percent) + "% used";
        if (reset != null) {
          try { text += " (reset " + new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc).AddSeconds(Convert.ToDouble(reset)).ToLocalTime().ToString("MM-dd HH:mm") + ")"; } catch { }
        }
      }
      return text;
    }
    void AddMenu() {
      if (accountMenu != null) accountMenu.Dispose();
      var menu = new ContextMenuStrip { Font = new Font("Segoe UI",10), BackColor = Theme.Card, ForeColor = Theme.Ink, Renderer = new ToolStripProfessionalRenderer(new MenuColors()) };
      accountMenu = menu;
      menu.Items.Add("Link current Codex login", null, async delegate { await AddAccount("link", null); });
      var login = menu.Items.Add("Sign in to another ChatGPT account", null, async delegate { await AddAccount("add", null); });
      login.Enabled = current != null && !Bool(current,"running");
      menu.Items.Add("Choose a Codex auth.json file…", null, async delegate {
        using (var picker = new OpenFileDialog { Title = "Choose a Codex auth.json file", Filter = "Codex auth.json|auth.json|JSON files|*.json", CheckFileExists = true }) {
          if (picker.ShowDialog(this) == DialogResult.OK) await AddAccount("link", picker.FileName);
        }
      });
      menu.Show(add, new Point(0, add.Height));
    }
    protected override void Dispose(bool disposing) {
      if (disposing) { timer.Dispose(); metadataTips.Dispose(); if (accountMenu != null) accountMenu.Dispose(); }
      base.Dispose(disposing);
    }
    async Task AddAccount(string method, string source) {
      using (var dialog = new AccountNameDialog(method == "add" ? "Sign in to ChatGPT" : "Codex link")) {
        if (dialog.ShowDialog(this) == DialogResult.OK) await Act(method, new { name = dialog.AccountName, source = source });
      }
    }
    void ShowError(string message) {
      recent.Text = Friendly(message);
      NoticeDialog.ShowMessage(this,Friendly(message),"OpenProxy");
    }
    static string Friendly(string message) {
      if (message.Contains("Add or link") || message.Contains("No account")) return "Add or link a ChatGPT account before starting the proxy.";
      if (message.Contains("No ChatGPT login")) return "No ChatGPT login was found in auth.json. Sign in separately or choose another Codex profile.";
      if (message.Contains("before changing its port")) return "Stop the proxy before changing its port.";
      if (message.Contains("before adding") || message.Contains("before changing")) return "Stop the proxy before adding or re-authenticating an account or changing settings.";
      if (message.Contains("already exists")) return "This account name already exists. Choose another name.";
      if (message.Contains("expiring")) return "The Codex session is expiring. Refresh its login in Codex or use an independent login.";
      if (message.Contains("changed identity")) return "The Codex profile has changed to another account. Link it again under a new name.";
      if (message.Contains("EADDRINUSE") || message.Contains("already in use")) return "Another application is using this port. Choose a different port in Settings.";
      return message;
    }
    internal static object Get(Dictionary<string, object> obj, string key) { object value; return obj != null && obj.TryGetValue(key,out value) ? value : null; }
    internal static string Str(Dictionary<string, object> obj, string key) { return Convert.ToString(Get(obj,key)) ?? ""; }
    internal static bool Bool(Dictionary<string, object> obj, string key) { return Get(obj,key) is bool && (bool)Get(obj,key); }
    static string StatusText(string status) {
      switch (status) { case "ready": return "Ready"; case "refresh-on-request": return "Refreshes on use"; case "needs-login": return "Sign-in required"; case "expired": return "Session expired"; case "identity-changed": return "Codex identity changed"; default: return "Check sign-in"; }
    }
  }

  sealed class NoticeDialog : DarkForm {
    NoticeDialog(string message, string title) {
      Text = title; ClientSize = new Size(510,235); FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false; MinimizeBox = false;
      BackColor = Theme.Card; ForeColor = Theme.Ink; AutoScaleMode = AutoScaleMode.Dpi; StartPosition = FormStartPosition.CenterParent;
      var content = new RichTextBox { Location = new Point(24,24), Size = new Size(462,142), ReadOnly = true, BorderStyle = BorderStyle.None, BackColor = Theme.Card, ForeColor = Theme.Ink, Font = new Font("Segoe UI",10), DetectUrls = false, Text = message };
      Controls.Add(content);
      var ok = new ActionButton("OK",true) { Location = new Point(382,183), Width = 104, DialogResult = DialogResult.OK }; Controls.Add(ok); AcceptButton = ok; CancelButton = ok;
    }
    public static void ShowMessage(IWin32Window owner, string message, string title) {
      using (var dialog = new NoticeDialog(message,title)) {
        if (owner == null) { dialog.StartPosition = FormStartPosition.CenterScreen; dialog.ShowDialog(); }
        else dialog.ShowDialog(owner);
      }
    }
  }

  sealed class AccountNameDialog : DarkForm {
    readonly TextBox name;
    public string AccountName { get { return name.Text.Trim(); } }
    public AccountNameDialog(string title) {
      Text = title; ClientSize = new Size(420,205); FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false; MinimizeBox = false; StartPosition = FormStartPosition.CenterParent; BackColor = Theme.Card; AutoScaleMode = AutoScaleMode.Dpi;
      Theme.Label(this,"Name this account",22,20,375,30,15,true,Theme.Ink);
      Theme.Label(this,"Use lowercase letters, numbers, hyphens, or underscores.",23,56,375,32,9,false,Theme.Muted);
      name = new TextBox { Location = new Point(24,98), Width = 370, Font = new Font("Segoe UI",12), AccessibleName = "Account name", BackColor = Theme.Canvas, ForeColor = Theme.Ink, BorderStyle = BorderStyle.FixedSingle }; Controls.Add(name);
      var ok = new ActionButton("Continue",true) { Location = new Point(276,151), Width = 118 };
      ok.Click += delegate {
        if (!System.Text.RegularExpressions.Regex.IsMatch(AccountName,"^[a-z0-9][a-z0-9_-]{0,39}$")) { NoticeDialog.ShowMessage(this,"Use 1–40 characters: lowercase letters, numbers, - or _.","Account name"); return; }
        DialogResult = DialogResult.OK;
      }; Controls.Add(ok);
      var cancel = new ActionButton("Cancel",false) { Location = new Point(170,151), Width = 94, DialogResult = DialogResult.Cancel }; Controls.Add(cancel);
      AcceptButton = ok; CancelButton = cancel;
    }
  }
  sealed class GettingStartedDialog : DarkForm {
    static readonly Color Background = Theme.Card, Sidebar = Theme.Canvas, TextColor = Theme.Ink, Secondary = Theme.Muted, Blue = Theme.Accent;
    readonly Label title, intro, codeTitle, feedback;
    readonly RichTextBox instructions, snippet;
    readonly Button copy;
    readonly Backend backend;
    readonly List<Button> navigation = new List<Button>();
    Dictionary<string, object> selected;
    public GettingStartedDialog(Dictionary<string, object> guide, Backend readyBackend) {
      backend = readyBackend;
      Text = "OpenProxy — Getting started"; ClientSize = new Size(1050,800); MinimumSize = new Size(940,720);
      StartPosition = FormStartPosition.CenterParent; BackColor = Background; AutoScaleMode = AutoScaleMode.Dpi;
      Font = new Font("Segoe UI",10); MinimizeBox = false; ShowInTaskbar = false;
      var shell = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 1, Margin = new Padding(0) };
      shell.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,220)); shell.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));
      Controls.Add(shell);
      var left = new Panel { Dock = DockStyle.Fill, BackColor = Sidebar, Margin = new Padding(0) }; shell.Controls.Add(left,0,0);
      Theme.Label(left,"Getting started",20,25,190,30,16,true,TextColor);
      Theme.Label(left,"CLIENT CONNECTION",22,76,185,24,8.5f,true,Secondary);
      Theme.Label(left,MainWindow.Str(guide,"endpoint"),22,108,185,38,9,false,Blue);
      var nav = new FlowLayoutPanel { Location = new Point(0,165), Size = new Size(220,280), FlowDirection = FlowDirection.TopDown, WrapContents = false, AccessibleName = "Client setup guides" }; left.Controls.Add(nav);
      var note = Theme.Label(left,"Edit a config file.\nNo terminal setup.",22,ClientSize.Height - 85,178,60,9,false,Secondary); note.Anchor = AnchorStyles.Left | AnchorStyles.Bottom;
      var right = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 7, Padding = new Padding(24), Margin = new Padding(0), BackColor = Background };
      right.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));
      right.RowStyles.Add(new RowStyle(SizeType.Absolute,40));
      right.RowStyles.Add(new RowStyle(SizeType.Absolute,56));
      right.RowStyles.Add(new RowStyle(SizeType.Percent,40));
      right.RowStyles.Add(new RowStyle(SizeType.Absolute,36));
      right.RowStyles.Add(new RowStyle(SizeType.Percent,60));
      right.RowStyles.Add(new RowStyle(SizeType.Absolute,28));
      right.RowStyles.Add(new RowStyle(SizeType.Absolute,44));
      shell.Controls.Add(right,1,0);
      title = new Label { Dock = DockStyle.Fill, ForeColor = TextColor, Font = new Font("Segoe UI",17,FontStyle.Bold) }; right.Controls.Add(title,0,0);
      intro = new Label { Dock = DockStyle.Fill, ForeColor = Secondary, Font = new Font("Segoe UI",10) }; right.Controls.Add(intro,0,1);
      instructions = new RichTextBox { Dock = DockStyle.Fill, ReadOnly = true, BorderStyle = BorderStyle.None, BackColor = Background, ForeColor = TextColor, Font = new Font("Segoe UI",10), ScrollBars = RichTextBoxScrollBars.Vertical, DetectUrls = false, AccessibleName = "Configuration steps" }; right.Controls.Add(instructions,0,2);
      codeTitle = new Label { Dock = DockStyle.Fill, ForeColor = Secondary, Padding = new Padding(0,8,0,0), AutoEllipsis = true }; right.Controls.Add(codeTitle,0,3);
      var codePanel = new Panel { Dock = DockStyle.Fill, Padding = new Padding(12), BackColor = Color.FromArgb(20,22,25), BorderStyle = BorderStyle.FixedSingle };
      snippet = new RichTextBox { Dock = DockStyle.Fill, ReadOnly = true, BorderStyle = BorderStyle.None, WordWrap = false, ScrollBars = RichTextBoxScrollBars.Both, BackColor = codePanel.BackColor, ForeColor = Theme.Ink, Font = new Font("Consolas",10), DetectUrls = false, AccessibleName = "Configuration snippet" }; codePanel.Controls.Add(snippet); right.Controls.Add(codePanel,0,4);
      feedback = new Label { Dock = DockStyle.Fill, ForeColor = Blue, Padding = new Padding(0,4,0,0), Font = new Font("Segoe UI",9) }; right.Controls.Add(feedback,0,5);
      var actions = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.LeftToRight, WrapContents = false };
      right.Controls.Add(actions,0,6);
      copy = new ActionButton("Copy config",true) { Width = 180, Height = 36 };
      copy.Click += async delegate {
        if (selected == null) return;
        string client = MainWindow.Str(selected,"id"); copy.Enabled = false;
        try {
          var result = await backend.Call("clientConfig",new { client = client });
          if (IsDisposed) return;
          Clipboard.SetText(Lines(MainWindow.Str(result,"text"))); feedback.Text = "Copied with your local proxy key. Keep the config private.";
        } catch { if (!IsDisposed) feedback.Text = "Could not copy the configuration. Reopen this guide and try again."; }
        finally { if (!copy.IsDisposed) copy.Enabled = true; }
      }; actions.Controls.Add(copy);
      var close = new ActionButton("Close",false) { Width = 90, Height = 36, DialogResult = DialogResult.Cancel, Margin = new Padding(12,3,0,0) }; actions.Controls.Add(close); CancelButton = close;
      object[] pages = MainWindow.Get(guide,"pages") as object[] ?? new object[0];
      foreach (Dictionary<string, object> page in pages) {
        var button = new Button { Text = MainWindow.Str(page,"title"), Tag = page, Width = 220, Height = 54, TextAlign = ContentAlignment.MiddleLeft, Padding = new Padding(20,0,0,0), FlatStyle = FlatStyle.Flat, BackColor = Sidebar, ForeColor = Secondary, Font = new Font("Segoe UI",10,FontStyle.Bold), Margin = new Padding(0), Cursor = Cursors.Hand, AccessibleName = MainWindow.Str(page,"title") };
        button.FlatAppearance.BorderSize = 0; button.FlatAppearance.MouseOverBackColor = Theme.Selected;
        button.Click += delegate { SelectPage(page); }; navigation.Add(button); nav.Controls.Add(button);
      }
      if (pages.Length > 0) SelectPage((Dictionary<string, object>)pages[0]);
    }
    static string Lines(string text) { return text.Replace("\r\n","\n").Replace("\n",Environment.NewLine); }
    void SelectPage(Dictionary<string, object> page) {
      selected = page; title.Text = MainWindow.Str(page,"title"); intro.Text = MainWindow.Str(page,"intro");
      instructions.Text = Lines(MainWindow.Str(page,"instructions")); instructions.Select(0,0); instructions.ScrollToCaret();
      snippet.Text = Lines(MainWindow.Str(page,"code")); snippet.Select(0,0); snippet.ScrollToCaret();
      copy.Text = MainWindow.Str(page,"copyLabel"); feedback.Text = "The local key is filled in when you copy.";
      codeTitle.Text = MainWindow.Str(page,"file");
      foreach (var button in navigation) {
        bool active = Object.ReferenceEquals(button.Tag,page);
        button.BackColor = active ? Theme.Selected : Sidebar;
        button.ForeColor = active ? Blue : Secondary;
      }
    }
  }

  sealed class SettingsDialog : DarkForm {
    readonly NumericUpDown port;
    public object Values { get { return new { port = (int)port.Value }; } }
    public SettingsDialog(Dictionary<string, object> state) {
      Text = "OpenProxy Settings"; ClientSize = new Size(560,226); FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false; MinimizeBox = false; StartPosition = FormStartPosition.CenterParent; BackColor = Theme.Card; AutoScaleMode = AutoScaleMode.Dpi;
      Theme.Label(this,"Connection settings",24,18,475,32,16,true,Theme.Ink);
      Theme.Label(this,"Local port",25,68,130,23,10,true,Theme.Ink);
      port = new NumericUpDown { Location = new Point(182,65), Width = 120, Minimum = 1024, Maximum = 65535, Value = Convert.ToDecimal(MainWindow.Get(state,"port")), Font = new Font("Segoe UI",11), AccessibleName = "Local port", BackColor = Theme.Canvas, ForeColor = Theme.Ink, BorderStyle = BorderStyle.FixedSingle }; Controls.Add(port);
      port.Enabled = !MainWindow.Bool(state,"running");
      Theme.Label(this,MainWindow.Bool(state,"running") ? "Stop the proxy to change its port. Reopen Getting started after changing the port." : "Use Getting started for client configuration. Manage projects and models in your client.",25,115,507,44,9.5f,false,Theme.Muted);
      var save = new ActionButton("Save settings",true) { Location = new Point(388,174), Width = 144, DialogResult = DialogResult.OK }; Controls.Add(save);
      var cancel = new ActionButton("Cancel",false) { Location = new Point(277,174), Width = 98, DialogResult = DialogResult.Cancel }; Controls.Add(cancel);
      AcceptButton = save; CancelButton = cancel;
    }
  }
}
