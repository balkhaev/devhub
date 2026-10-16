// «Пульт» в трее: значок открывает небольшое окно управления, держит пульт запущенным и включает автозапуск.
// Пока пульт работает, в меню есть и общая очередь GPU/CPU: её состояние, «Стоп», «Пауза», «Продолжить»
// Эти пункты пульт присылает готовыми (GET api/queue/tray), значок их только рисует
// и отправляет нажатия обратно в пульт: об очереди он сам ничего не знает.
// Пульт поднимает именно значок, в сеансе самого человека: клиент командной строки, заставший пульт молчащим,
// просит об этом событием Local\DevhubTray.Start. Запущенный изнутри приложения-агента (у его процессов своя
// копия %LOCALAPPDATA%), значок сам перезапускается через рабочий стол.
// Собирается компилятором C# из .NET Framework 4, который есть в каждой Windows (scripts/install-windows.ps1),
// поэтому написан на C# 5: другого этот компилятор не знает.

using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("Пульт")]
[assembly: AssemblyDescription("Серверы разработки всех проектов и их страницы в одном месте")]
[assembly: AssemblyProduct("Пульт")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

namespace Devhub
{
    internal static class Program
    {
        private const string MutexName = "Local\\DevhubTray";

        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();

        /// <summary>
        /// Without arguments: the tray and its control window. <c>--background</c>: the tray alone (at
        /// sign-in). A second copy passes its wish to the running one: open the page, <c>--close</c> the tray
        /// (the hub keeps running), <c>--stop</c> the tray and the hub, or <c>--restart</c> the hub alone.
        /// <c>--write-icon file.ico</c> draws the icon.
        /// A copy started from inside a packaged app starts itself again through the desktop shell (which adds
        /// <c>--outside</c>) and ends: the tray, the hub and the servers never live in that app's view.
        /// </summary>
        [STAThread]
        private static int Main(string[] args)
        {
            if (args.Length == 2 && args[0] == "--write-icon")
            {
                Icons.WriteIco(args[1]);
                return 0;
            }
            bool restart = Array.IndexOf(args, "--restart") >= 0;
            bool background = Array.IndexOf(args, "--background") >= 0 || restart;
            bool close = Array.IndexOf(args, "--close") >= 0;
            bool stop = Array.IndexOf(args, "--stop") >= 0;
            bool first;
            var mutex = new Mutex(true, MutexName, out first);
            try
            {
                if (!first)
                {
                    if (close)
                    {
                        Signals.Send(Signals.Close);
                    }
                    else if (stop)
                    {
                        Signals.Send(Signals.Stop);
                    }
                    else if (restart)
                    {
                        Signals.Send(Signals.Restart);
                    }
                    else if (!background)
                    {
                        Signals.Send(Signals.Open);
                    }
                    return 0;
                }
                if (close || stop)
                {
                    // Nothing runs in the tray: nothing to close.
                    return 0;
                }
                string owner = AppView.Owner();
                if (owner != null)
                {
                    // The copy the shell starts must find no tray yet: the name is let go first.
                    mutex.Dispose();
                    return Leave(owner, background, Array.IndexOf(args, "--outside") >= 0);
                }
                if (Environment.OSVersion.Version.Major >= 6)
                {
                    SetProcessDPIAware();
                }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                string root = Hub.FindRoot();
                if (root == null)
                {
                    MessageBox.Show(
                        "Не нашёл папку пульта (в ней services.json и src) выше " + AppDomain.CurrentDomain.BaseDirectory,
                        "Пульт",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Error);
                    return 1;
                }
                using (var signals = new Signals())
                using (var tray = new TrayApp(new Hub(root), signals, !background))
                {
                    Application.Run(tray);
                }
            }
            finally
            {
                mutex.Dispose();
            }
            return 0;
        }

        /// <summary>
        /// This copy works in an app's private view: the same program is started through the desktop shell, where
        /// it sees the real folders, and this one ends. A copy the shell itself started is not passed on again.
        /// </summary>
        private static int Leave(string owner, bool background, bool outside)
        {
            string why = "запущенная через него программа оказалась там же";
            if (!outside)
            {
                try
                {
                    AppView.StartOutside(
                        Application.ExecutablePath,
                        background ? "--background --outside" : "--outside",
                        Path.GetDirectoryName(Application.ExecutablePath));
                    return 0;
                }
                catch (Exception error)
                {
                    why = error.Message;
                }
            }
            MessageBox.Show(
                "Значок запущен из приложения " + owner + ": пульт и серверы проектов получили бы от него отдельную копию "
                    + "%LOCALAPPDATA%. Запустить его через рабочий стол не удалось (" + why + "). "
                    + "Запустите «Пульт» ярлыком на рабочем столе.",
                "Пульт",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
            return 1;
        }
    }

    /// <summary>
    /// Whose %LOCALAPPDATA% this process works in. A packaged desktop app (Claude, Codex) gives every process started
    /// from it, however deep, a private copy laid over the real folder: a new file lands in
    /// Packages\&lt;package&gt;\LocalCache\Local, and a file already there hides the real one. Windows names no
    /// package for such a process, so the folder itself is asked (the same check as src\app-view.ts).
    /// </summary>
    internal static class AppView
    {
        private static readonly Guid ShellWindows = new Guid("9BA05972-F6A8-11CF-A442-00A0C90A8F39");

        /// <summary>The package whose private copy this process works in; null when it sees the real folder.</summary>
        public static string Owner()
        {
            string local = Environment.GetEnvironmentVariable("LOCALAPPDATA");
            if (string.IsNullOrEmpty(local))
            {
                return null;
            }
            string name = "devhub-view-" + Process.GetCurrentProcess().Id + "-"
                + Guid.NewGuid().ToString("N").Substring(0, 12) + ".probe";
            string probe = Path.Combine(local, name);
            try
            {
                new FileStream(probe, FileMode.CreateNew).Dispose();
            }
            catch (Exception)
            {
                // Nothing can be created here, so nothing of this process can land in a private copy either.
                return null;
            }
            try
            {
                foreach (string package in Directory.GetDirectories(Path.Combine(local, "Packages")))
                {
                    if (File.Exists(Path.Combine(package, "LocalCache", "Local", name)))
                    {
                        return Path.GetFileName(package);
                    }
                }
            }
            catch (Exception)
            {
                // No packaged apps at all.
            }
            finally
            {
                try
                {
                    File.Delete(probe);
                }
                catch (Exception)
                {
                    // An empty file is left behind.
                }
            }
            return null;
        }

        /// <summary>
        /// Starts a program through the desktop shell: the desktop's window is found among the shell's windows
        /// (SWC_DESKTOP = 8) as a scriptable object (SWFO_NEEDDISPATCH = 1), and its ShellExecute runs in Explorer's
        /// own process. The program is Explorer's child and keeps nothing of the caller's view.
        /// </summary>
        public static void StartOutside(string file, string arguments, string directory)
        {
            dynamic windows = Activator.CreateInstance(Type.GetTypeFromCLSID(ShellWindows));
            object location = 0;
            object root = null;
            int hwnd;
            dynamic desktop = windows.FindWindowSW(ref location, ref root, 8, out hwnd, 1);
            desktop.Document.Application.ShellExecute(file, arguments, directory, "open", 1);
        }
    }

    /// <summary>
    /// Named events through which another program asks the running tray to act: a second copy of this one (open,
    /// close, stop), and the hub's command-line client, which sets <see cref="Start"/> when it finds the hub silent
    /// (src\open.ts).
    /// </summary>
    internal sealed class Signals : IDisposable
    {
        public const string Open = "Local\\DevhubTray.Open";
        public const string Close = "Local\\DevhubTray.Close";
        public const string Stop = "Local\\DevhubTray.Stop";
        public const string Start = "Local\\DevhubTray.Start";
        public const string Restart = "Local\\DevhubTray.Restart";

        public readonly EventWaitHandle[] Handles;

        public Signals()
        {
            Handles = new[]
            {
                new EventWaitHandle(false, EventResetMode.AutoReset, Open),
                new EventWaitHandle(false, EventResetMode.AutoReset, Close),
                new EventWaitHandle(false, EventResetMode.AutoReset, Stop),
                new EventWaitHandle(false, EventResetMode.AutoReset, Start),
                new EventWaitHandle(false, EventResetMode.AutoReset, Restart),
            };
        }

        public static void Send(string name)
        {
            try
            {
                using (var handle = EventWaitHandle.OpenExisting(name))
                {
                    handle.Set();
                }
            }
            catch (WaitHandleCannotBeOpenedException)
            {
                // The running copy is only starting: it opens the page by itself once the hub answers.
            }
        }

        public void Dispose()
        {
            foreach (var handle in Handles)
            {
                handle.Dispose();
            }
        }
    }

    internal sealed class Health
    {
        public int Managed;
        public int Pid;
        public bool Up;
    }

    /// <summary>One line of the queue's part of the menu, as the hub words it.</summary>
    internal sealed class QueueItem
    {
        public bool Checked;
        public bool Enabled;
        /// <summary>A page of the hub to open in the browser.</summary>
        public string Open;
        /// <summary>A hub action to send when the item is chosen.</summary>
        public string Post;
        public bool Separator;
        public string Text;

        public static QueueItem From(Dictionary<string, object> entry)
        {
            if (Flag(entry, "separator"))
            {
                return new QueueItem { Separator = true };
            }
            string text = Word(entry, "text");
            if (string.IsNullOrEmpty(text))
            {
                return null;
            }
            return new QueueItem
            {
                Checked = Flag(entry, "checked"),
                Enabled = Flag(entry, "enabled"),
                Open = Word(entry, "open"),
                Post = Word(entry, "post"),
                Text = text,
            };
        }

        private static bool Flag(Dictionary<string, object> entry, string key)
        {
            object value;
            return entry.TryGetValue(key, out value) && value is bool && (bool)value;
        }

        private static string Word(Dictionary<string, object> entry, string key)
        {
            object value;
            return entry.TryGetValue(key, out value) ? value as string : null;
        }
    }

    /// <summary>
    /// The shared queue's part of the tray menu. The hub sends it ready to draw; an answer that cannot be read is an
    /// empty menu, the same as a hub without a queue.
    /// </summary>
    internal sealed class QueueMenu
    {
        public readonly List<QueueItem> Items = new List<QueueItem>();
        /// <summary>The answer as it came: the menu is drawn again only when this changes.</summary>
        public string Json = "";
        /// <summary>A few words for the icon's tooltip.</summary>
        public string Tip = "";
        /// <summary>Safe observations shared with the page's queue widget.</summary>
        public Dictionary<string, object> Status;

        public static QueueMenu Parse(string json)
        {
            var menu = new QueueMenu();
            try
            {
                var data = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(json);
                object status;
                if (data.TryGetValue("status", out status))
                {
                    menu.Status = status as Dictionary<string, object>;
                }
                object tip;
                if (data.TryGetValue("tip", out tip) && tip is string)
                {
                    menu.Tip = ((string)tip).Replace('\r', ' ').Replace('\n', ' ');
                }
                object items;
                var list = data.TryGetValue("items", out items) ? items as IEnumerable : null;
                if (list != null && !(items is string))
                {
                    foreach (object raw in list)
                    {
                        var entry = raw as Dictionary<string, object>;
                        QueueItem item = entry == null ? null : QueueItem.From(entry);
                        if (item != null)
                        {
                            menu.Items.Add(item);
                        }
                    }
                }
                menu.Json = json;
            }
            catch (Exception)
            {
                return new QueueMenu();
            }
            return menu;
        }
    }

    /// <summary>The full queue and measured progress, embedded in the tray's persistent control window.</summary>
    internal sealed class QueueView : Control
    {
        private const int HeaderHeight = 40;
        private const int JobHeight = 54;
        private const int WaitingHeight = 32;
        private static readonly Color Background = Color.FromArgb(24, 27, 33);
        private static readonly Color Muted = Color.FromArgb(154, 165, 181);
        private static readonly Color Accent = Color.FromArgb(89, 202, 170);
        private static readonly Color Divider = Color.FromArgb(48, 55, 66);
        private readonly Font heading;
        private readonly Font small;
        private readonly float scale;
        private Dictionary<string, object> snapshot;
        private readonly List<Dictionary<string, object>> jobs = new List<Dictionary<string, object>>();
        private readonly List<Dictionary<string, object>> waiting = new List<Dictionary<string, object>>();
        private readonly List<QueueRow> rows = new List<QueueRow>();
        private int contentHeight;
        private int viewportHeight;
        private int scrollOffset;
        private bool draggingScroll;
        private int dragY;
        private int dragOffset;

        private sealed class QueueRow
        {
            public Dictionary<string, object> Job;
            public bool Waiting;
            public string Label;
            public int Position;
            public int Height;
            public int Index;
        }

        public QueueView()
        {
            BackColor = Background;
            ForeColor = Color.FromArgb(235, 240, 247);
            Font = new Font("Segoe UI", 9);
            heading = new Font(Font, FontStyle.Bold);
            small = new Font("Segoe UI", 8);
            using (Graphics graphics = CreateGraphics()) { scale = graphics.DpiX / 96f; }
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint
                | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.Selectable, true);
            TabStop = true;
            Size = new Size(Px(400), Px(360));
            UpdateStatus(null);
        }

        public bool Busy { get { return Number(snapshot, "running") > 0 || Number(snapshot, "queued") > 0 || jobs.Count + waiting.Count > 0; } }
        internal int ListedJobs { get { return jobs.Count + waiting.Count; } }
        internal int WaitingJobs { get { return waiting.Count; } }
        internal int ScrollOffset { get { return scrollOffset; } }
        internal int MaximumScroll { get { return Math.Max(0, contentHeight - viewportHeight); } }
        internal Rectangle ListBounds { get { return new Rectangle(0, Px(HeaderHeight), ClientSize.Width, Px(viewportHeight)); } }
        internal bool QueueIncomplete { get { return Value(snapshot, "queued") == null || Number(snapshot, "queued") > waiting.Count; } }
        private int Px(float value) { return (int)Math.Round(value * scale); }

        private static object Value(Dictionary<string, object> data, string key)
        {
            object value;
            return data != null && data.TryGetValue(key, out value) ? value : null;
        }

        private static string Word(Dictionary<string, object> data, string key)
        {
            return Value(data, key) as string ?? "";
        }

        private static double Number(Dictionary<string, object> data, string key)
        {
            object value = Value(data, key);
            if (!(value is int || value is long || value is double || value is decimal)) { return 0; }
            return Convert.ToDouble(value);
        }

        private static string Scope(Dictionary<string, object> progress)
        {
            switch (Word(progress, "scope"))
            {
                case "job": return "задания";
                case "stage": return "этапа";
                default: return "операции";
            }
        }

        internal static string ProgressWords(Dictionary<string, object> progress)
        {
            if (progress == null) { return "Ожидаем данные о прогрессе"; }
            var words = new List<string>();
            string phase = Word(progress, "phaseTitle");
            if (phase.Length > 0) { words.Add(phase); }
            if (Value(progress, "percent") != null)
            {
                words.Add(Number(progress, "percent").ToString("0.#") + "% " + Scope(progress));
            }
            if (Value(progress, "step") != null && Value(progress, "totalSteps") != null)
            {
                words.Add("шаг " + Number(progress, "step") + " из " + Number(progress, "totalSteps"));
            }
            return string.Join(" · ", words.ToArray());
        }

        private static string Detail(Dictionary<string, object> progress)
        {
            if (progress == null) { return "Выполняется · прогресс пока неизвестен"; }
            var words = new List<string>();
            string phase = Word(progress, "phaseTitle");
            words.Add(phase.Length > 0 ? phase : "Выполняется");
            // Keep the measurement's scope beside its phase: a node's percentage is not a whole-job estimate.
            if (Value(progress, "percent") != null) { words.Add("прогресс " + Scope(progress)); }
            if (Value(progress, "step") != null && Value(progress, "totalSteps") != null)
            {
                words.Add(Number(progress, "step") + "/" + Number(progress, "totalSteps"));
            }
            return string.Join(" · ", words.ToArray());
        }

        public void UpdateStatus(Dictionary<string, object> status)
        {
            snapshot = status;
            ReadJobs(jobs, Value(status, "jobs"));
            ReadJobs(waiting, Value(status, "queuedJobs"));
            BuildRows();
            MeasureViewport();
            Invalidate();
        }

        private static void ReadJobs(List<Dictionary<string, object>> target, object value)
        {
            target.Clear();
            var list = value as IEnumerable;
            if (list != null)
            {
                foreach (object raw in list)
                {
                    var job = raw as Dictionary<string, object>;
                    if (job != null) { target.Add(job); }
                }
            }
        }

        private void AddRow(QueueRow row, int height)
        {
            row.Position = contentHeight;
            row.Height = height;
            rows.Add(row);
            contentHeight += height;
        }

        private void BuildRows()
        {
            rows.Clear();
            contentHeight = 0;
            if (snapshot == null || Word(snapshot, "state") == "offline")
            {
                AddRow(new QueueRow { Label = snapshot == null ? "Состояние очереди пока недоступно" : "Нет связи с Inference" }, 32);
                return;
            }
            foreach (var job in jobs) { AddRow(new QueueRow { Job = job }, JobHeight); }
            if (Number(snapshot, "running") > jobs.Count)
            {
                AddRow(new QueueRow { Label = "Ещё выполняется: " + (Number(snapshot, "running") - jobs.Count) + " · нет подробностей" }, 24);
            }
            if (waiting.Count > 0 || Number(snapshot, "queued") > 0 || Value(snapshot, "queued") == null)
            {
                AddRow(new QueueRow { Label = "ОЖИДАЮТ" }, 24);
                for (int i = 0; i < waiting.Count; i++)
                {
                    AddRow(new QueueRow { Job = waiting[i], Waiting = true, Index = i + 1 }, WaitingHeight);
                }
                if (QueueIncomplete)
                {
                    string note = Value(snapshot, "queuedJobs") == null ? "Список ожидающих недоступен"
                        : Value(snapshot, "queued") == null ? "Размер очереди неизвестен"
                        : "Ещё ожидают: " + (Number(snapshot, "queued") - waiting.Count) + " · нет подробностей";
                    AddRow(new QueueRow { Label = note }, 24);
                }
            }
            if (rows.Count == 0) { AddRow(new QueueRow { Label = "Очередь пуста" }, 24); }
        }

        private int FooterHeight()
        {
            int rows = (Value(snapshot, "gpu") == null ? 0 : 1) + (Value(snapshot, "host") == null ? 0 : 1);
            return rows > 0 ? rows * 20 + 14 : 0;
        }

        private void MeasureViewport()
        {
            if (scale <= 0) { return; }
            viewportHeight = Math.Max(1, (int)Math.Floor(ClientSize.Height / scale) - HeaderHeight - FooterHeight() - 6);
            scrollOffset = Math.Min(scrollOffset, MaximumScroll);
        }

        internal void ScrollBy(int delta)
        {
            scrollOffset = Math.Max(0, Math.Min(MaximumScroll, scrollOffset + delta));
            Invalidate(ListBounds);
        }

        private static GraphicsPath Rounded(RectangleF rectangle, float radius)
        {
            var path = new GraphicsPath();
            float diameter = Math.Min(radius * 2, Math.Min(rectangle.Width, rectangle.Height));
            path.AddArc(rectangle.Left, rectangle.Top, diameter, diameter, 180, 90);
            path.AddArc(rectangle.Right - diameter, rectangle.Top, diameter, diameter, 270, 90);
            path.AddArc(rectangle.Right - diameter, rectangle.Bottom - diameter, diameter, diameter, 0, 90);
            path.AddArc(rectangle.Left, rectangle.Bottom - diameter, diameter, diameter, 90, 90);
            path.CloseFigure();
            return path;
        }

        protected override void OnSizeChanged(EventArgs e)
        {
            base.OnSizeChanged(e);
            if (scale <= 0 || Width <= 0 || Height <= 0) { return; }
            MeasureViewport();
        }

        private void TextLine(Graphics graphics, string text, Font font, Color color,
            int x, int y, int width, int height, bool right)
        {
            TextRenderer.DrawText(graphics, text, font,
                new Rectangle(Px(x), Px(y), Px(width), Px(height)), color,
                TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix | TextFormatFlags.SingleLine
                | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding
                | TextFormatFlags.PreserveGraphicsClipping
                | (right ? TextFormatFlags.Right : TextFormatFlags.Left));
        }

        private void Bar(Graphics graphics, Dictionary<string, object> progress, int y)
        {
            var rectangle = new RectangleF(Px(14), Px(y), ClientSize.Width - Px(28), Px(3));
            using (GraphicsPath track = Rounded(rectangle, Px(2)))
            {
                using (var brush = new SolidBrush(Divider)) { graphics.FillPath(brush, track); }
                if (progress != null && Value(progress, "percent") != null)
                {
                    // Clip the exact observed width instead of rounding a tiny percentage up to a whole pill.
                    float width = rectangle.Width * (float)Math.Max(0, Math.Min(100, Number(progress, "percent"))) / 100;
                    GraphicsState saved = graphics.Save();
                    graphics.SetClip(new RectangleF(rectangle.X, rectangle.Y, width, rectangle.Height), CombineMode.Intersect);
                    using (var brush = new SolidBrush(Accent)) { graphics.FillPath(brush, track); }
                    graphics.Restore(saved);
                }
                else
                {
                    using (var brush = new HatchBrush(HatchStyle.Percent10, Muted, Divider)) { graphics.FillPath(brush, track); }
                }
            }
        }

        private void Job(Graphics graphics, Dictionary<string, object> job, int y, int width)
        {
            bool anonymous = object.Equals(Value(job, "private"), true);
            string resource = Word(job, "resource").ToUpperInvariant();
            string name = anonymous ? "Анонимное задание" : Word(job, "name");
            Color color = resource == "GPU" ? Accent : Color.FromArgb(155, 181, 240);
            int nameX = 14;
            if (resource.Length > 0)
            {
                using (GraphicsPath badge = Rounded(new RectangleF(Px(14), Px(y + 1), Px(31), Px(16)), Px(4)))
                using (var brush = new SolidBrush(Color.FromArgb(36, 44, 54))) { graphics.FillPath(brush, badge); }
                TextLine(graphics, resource, small, color, 18, y, 27, 18, false);
                nameX = 53;
            }
            var progress = Value(job, "progress") as Dictionary<string, object>;
            bool measured = Value(progress, "percent") != null;
            TextLine(graphics, name, Font, ForeColor, nameX, y, width - nameX - 78, 18, false);
            TextLine(graphics, measured ? Number(progress, "percent").ToString("0.#") + "%" : "—",
                heading, measured ? Accent : Muted, width - 76, y, 62, 18, true);
            TextLine(graphics, Detail(progress), small, Muted, 14, y + 20, width - 28, 18, false);
            Bar(graphics, progress, y + 42);
        }

        private void WaitingJob(Graphics graphics, QueueRow row, int y, int width)
        {
            bool anonymous = object.Equals(Value(row.Job, "private"), true);
            string name = anonymous ? "Анонимное задание" : Word(row.Job, "name");
            string resource = Word(row.Job, "resource").ToUpperInvariant();
            int nameX = 14;
            if (resource.Length > 0)
            {
                TextLine(graphics, resource, small, Muted, 14, y + 5, 32, 20, false);
                nameX = 53;
            }
            TextLine(graphics, name, Font, ForeColor, nameX, y + 5, width - nameX - 54, 20, false);
            TextLine(graphics, "#" + row.Index, small, Muted, width - 51, y + 5, 37, 20, true);
        }

        private Rectangle ScrollTrack
        {
            get { return new Rectangle(ClientSize.Width - Px(8), Px(HeaderHeight + 2), Px(5), Math.Max(1, Px(viewportHeight - 4))); }
        }

        private Rectangle ScrollThumb
        {
            get
            {
                Rectangle track = ScrollTrack;
                int height = Math.Min(track.Height, Math.Max(Px(24), (int)((double)viewportHeight / Math.Max(1, contentHeight) * track.Height)));
                int top = track.Top + (MaximumScroll == 0 ? 0 : (int)((double)scrollOffset / MaximumScroll * (track.Height - height)));
                return new Rectangle(track.Left, top, track.Width, height);
            }
        }

        protected override void OnMouseWheel(MouseEventArgs e)
        {
            base.OnMouseWheel(e);
            ScrollBy(-(int)(e.Delta / 120f * 48));
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            Focus();
            if (e.Button != MouseButtons.Left || MaximumScroll == 0) { return; }
            Rectangle target = ScrollTrack;
            target.Inflate(Px(5), 0);
            if (!target.Contains(e.Location)) { return; }
            if (!ScrollThumb.Contains(e.Location)) { ScrollBy(e.Y < ScrollThumb.Top ? -viewportHeight : viewportHeight); }
            draggingScroll = true;
            dragY = e.Y;
            dragOffset = scrollOffset;
            Capture = true;
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            if (!draggingScroll) { return; }
            int travel = Math.Max(1, ScrollTrack.Height - ScrollThumb.Height);
            int wanted = dragOffset + (int)((double)(e.Y - dragY) / travel * MaximumScroll);
            ScrollBy(wanted - scrollOffset);
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            draggingScroll = false;
            Capture = false;
        }

        protected override void OnMouseCaptureChanged(EventArgs e)
        {
            base.OnMouseCaptureChanged(e);
            if (!Capture) { draggingScroll = false; }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            Graphics graphics = e.Graphics;
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (GraphicsPath border = Rounded(new RectangleF(0.5f, 0.5f, Width - 1, Height - 1), Px(11)))
            using (var pen = new Pen(Color.FromArgb(62, 71, 85))) { graphics.DrawPath(pen, border); }
            int width = (int)Math.Round(ClientSize.Width / scale);
            string state = Word(snapshot, "state");
            bool held = state == "paused" || state == "stopped";
            bool unavailable = snapshot == null || state == "offline";
            using (var dot = new SolidBrush(unavailable ? Muted : held ? Color.FromArgb(236, 184, 95) : Accent))
            {
                graphics.FillEllipse(dot, Px(14), Px(18), Px(5), Px(5));
            }
            TextLine(graphics, "Очередь", heading, ForeColor, 26, 10, 70, 20, false);
            string summary = (held ? (state == "stopped" ? "Стоп · " : "Пауза · ") : "")
                + Number(snapshot, "running") + " в работе · "
                + (Value(snapshot, "queued") == null ? "?" : Number(snapshot, "queued").ToString()) + " ждут";
            if (unavailable) { summary = snapshot == null ? "Нет данных" : "Нет связи"; }
            TextLine(graphics, summary, small, held ? Color.FromArgb(236, 184, 95) : Muted, 100, 10, width - 114, 20, true);
            GraphicsState saved = graphics.Save();
            graphics.SetClip(ListBounds, CombineMode.Intersect);
            int rowWidth = width - (MaximumScroll > 0 ? 8 : 0);
            foreach (QueueRow row in rows)
            {
                int rowY = HeaderHeight + row.Position - scrollOffset;
                if (rowY + row.Height <= HeaderHeight || rowY >= HeaderHeight + viewportHeight) { continue; }
                if (row.Job == null) { TextLine(graphics, row.Label, small, Muted, 14, rowY + 2, rowWidth - 28, row.Height - 2, false); }
                else if (row.Waiting) { WaitingJob(graphics, row, rowY, rowWidth); }
                else { Job(graphics, row.Job, rowY, rowWidth); }
            }
            graphics.Restore(saved);
            if (MaximumScroll > 0)
            {
                using (var track = new SolidBrush(Divider)) { graphics.FillRectangle(track, ScrollTrack); }
                using (var thumb = new SolidBrush(Muted)) { graphics.FillRectangle(thumb, ScrollThumb); }
            }
            int y = HeaderHeight + viewportHeight;
            if (FooterHeight() > 0)
            {
                using (var pen = new Pen(Divider)) { graphics.DrawLine(pen, Px(14), Px(y), ClientSize.Width - Px(14), Px(y)); }
                y += 6;
            }
            var gpu = Value(snapshot, "gpu") as Dictionary<string, object>;
            if (gpu != null)
            {
                TextLine(graphics, "GPU  " + Number(gpu, "utilization").ToString("0") + "% · "
                    + Number(gpu, "temperature").ToString("0") + "°", small, Muted, 14, y, 140, 20, false);
                TextLine(graphics, "VRAM  " + (Number(gpu, "usedMb") / 1024).ToString("0.#") + " / "
                    + (Number(gpu, "totalMb") / 1024).ToString("0.#") + " ГБ", small, Muted, 154, y, width - 168, 20, true);
                y += 20;
            }
            var host = Value(snapshot, "host") as Dictionary<string, object>;
            if (host != null)
            {
                TextLine(graphics, "CPU  " + Number(host, "cpu").ToString("0") + "%", small, Muted, 14, y, 140, 20, false);
                TextLine(graphics, "RAM  " + ((Number(host, "totalMb") - Number(host, "availableMb")) / 1024).ToString("0.#") + " / "
                    + (Number(host, "totalMb") / 1024).ToString("0.#") + " ГБ", small, Muted, 154, y, width - 168, 20, true);
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) { heading.Dispose(); small.Dispose(); Font.Dispose(); }
            base.Dispose(disposing);
        }
    }


    /// <summary>The hub's server: where it lives, whether it answers, starting and stopping it.</summary>
    internal sealed class Hub
    {
        public readonly int Port;
        public readonly string Root;
        private readonly object guard = new object();
        private Process started;
        private string startedBun;
        private string token = "";

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct ProcessEntry
        {
            public uint Size;
            public uint Usage;
            public uint Pid;
            public IntPtr Heap;
            public uint Module;
            public uint Threads;
            public uint Parent;
            public int Priority;
            public uint Flags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
            public string Executable;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "Process32FirstW")]
        private static extern bool Process32First(IntPtr snapshot, ref ProcessEntry entry);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "Process32NextW")]
        private static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry entry);

        [DllImport("kernel32.dll")]
        private static extern bool CloseHandle(IntPtr handle);

        public Hub(string root)
        {
            Root = root;
            Port = ReadPort(root);
        }

        public string Logs
        {
            get { return Path.Combine(Root, ".logs"); }
        }

        public string Url
        {
            get { return "http://127.0.0.1:" + Port + "/"; }
        }

        /// <summary>The hub's folder: the first one up from this program with services.json and src in it.</summary>
        public static string FindRoot()
        {
            var dir = new DirectoryInfo(AppDomain.CurrentDomain.BaseDirectory);
            while (dir != null)
            {
                bool catalogue = File.Exists(Path.Combine(dir.FullName, "services.json"));
                if (catalogue && Directory.Exists(Path.Combine(dir.FullName, "src")))
                {
                    return dir.FullName;
                }
                dir = dir.Parent;
            }
            return null;
        }

        private static int ReadPort(string root)
        {
            try
            {
                string text = File.ReadAllText(Path.Combine(root, "services.json"), Encoding.UTF8);
                var data = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(text);
                object port;
                if (data.TryGetValue("port", out port))
                {
                    return Convert.ToInt32(port);
                }
            }
            catch (Exception)
            {
                // A catalogue that cannot be read: the hub's usual port.
            }
            return 4700;
        }

        /// <summary>Asks the hub whether it runs; its answer names its process and counts the servers it started.</summary>
        public Health Check()
        {
            try
            {
                var request = (HttpWebRequest)WebRequest.Create(Url + "api/health");
                request.Timeout = 2000;
                request.ReadWriteTimeout = 2000;
                request.Proxy = null;
                using (var response = (HttpWebResponse)request.GetResponse())
                using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                {
                    var data = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
                    return new Health
                    {
                        Managed = Convert.ToInt32(data["managed"]),
                        Pid = Convert.ToInt32(data["pid"]),
                        Up = true,
                    };
                }
            }
            catch (Exception)
            {
                return new Health();
            }
        }

        /// <summary>The queue's part of the menu as the hub words it now; empty when the hub has none or is silent.</summary>
        public QueueMenu ReadQueueMenu()
        {
            int status;
            string body = Authorized("GET", "api/queue/tray", 4000, out status);
            return status == 200 && body != null ? QueueMenu.Parse(body) : new QueueMenu();
        }

        /// <summary>Sends one of the queue menu's commands to the hub; returns what went wrong, or null.</summary>
        public string Command(string path)
        {
            // The menu comes from the hub, yet only its queue commands are ever sent from here.
            if (path == null || !path.StartsWith("/api/queue/", StringComparison.Ordinal))
            {
                return "Неизвестная команда очереди";
            }
            int status;
            // The hub itself waits for the queue for a few seconds.
            string body = Authorized("POST", path.TrimStart('/'), 15000, out status);
            if (status == 200)
            {
                return null;
            }
            string said = ErrorOf(body);
            if (said != null)
            {
                return said;
            }
            return status == 0 ? "Пульт не отвечает" : "Пульт ответил HTTP " + status;
        }

        /// <summary>Whether an address from the menu is a page of this hub: nothing else is opened from it.</summary>
        public bool Owns(string url)
        {
            return url != null && url.StartsWith(Url, StringComparison.Ordinal);
        }

        /// <summary>
        /// The hub's local client token from .state\client-token: what lets this program, which has no page, read
        /// the queue's menu and send its commands. Read again when asked afresh (the hub refused the one in hand).
        /// </summary>
        private string Token(bool fresh)
        {
            lock (guard)
            {
                if (fresh || token.Length == 0)
                {
                    try
                    {
                        token = File.ReadAllText(Path.Combine(Root, ".state", "client-token"), Encoding.UTF8).Trim();
                    }
                    catch (Exception)
                    {
                        // The hub writes it when it first starts.
                        token = "";
                    }
                }
                return token;
            }
        }

        /// <summary>A request with the client token; refused once, it is repeated with the token read again.</summary>
        private string Authorized(string method, string path, int timeoutMs, out int status)
        {
            string used = Token(false);
            string body = Ask(method, path, used, timeoutMs, out status);
            if (status != 403)
            {
                return body;
            }
            string current = Token(true);
            return current == used ? body : Ask(method, path, current, timeoutMs, out status);
        }

        /// <summary>The answer's text and status; status 0 and no text when the hub did not answer at all.</summary>
        private string Ask(string method, string path, string credential, int timeoutMs, out int status)
        {
            status = 0;
            if (credential.Length == 0)
            {
                return null;
            }
            try
            {
                var request = (HttpWebRequest)WebRequest.Create(Url + path);
                request.Method = method;
                request.Timeout = timeoutMs;
                request.ReadWriteTimeout = timeoutMs;
                request.Proxy = null;
                request.Headers["x-devhub-client"] = credential;
                if (method == "POST")
                {
                    request.ContentLength = 0;
                }
                using (var response = (HttpWebResponse)request.GetResponse())
                {
                    status = (int)response.StatusCode;
                    return ReadText(response);
                }
            }
            catch (WebException error)
            {
                // A refusal or a failed action still carries the hub's words.
                var response = error.Response as HttpWebResponse;
                if (response == null)
                {
                    return null;
                }
                using (response)
                {
                    try
                    {
                        status = (int)response.StatusCode;
                        return ReadText(response);
                    }
                    catch (Exception)
                    {
                        return null;
                    }
                }
            }
            catch (Exception)
            {
                return null;
            }
        }

        private static string ReadText(HttpWebResponse response)
        {
            using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
            {
                return reader.ReadToEnd();
            }
        }

        private static string ErrorOf(string body)
        {
            if (string.IsNullOrEmpty(body))
            {
                return null;
            }
            try
            {
                var data = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(body);
                object error;
                string text = data.TryGetValue("error", out error) ? error as string : null;
                return string.IsNullOrEmpty(text) ? null : text;
            }
            catch (Exception)
            {
                return null;
            }
        }

        /// <summary>
        /// Starts the hub hidden, its output into .logs\hub.log. It does not hang on this program: closing the tray
        /// alone leaves it running.
        /// </summary>
        public void Start()
        {
            string bun = FindBun();
            if (bun == null)
            {
                throw new InvalidOperationException("не найден bun: установите его или добавьте в PATH");
            }
            Directory.CreateDirectory(Logs);
            var info = new ProcessStartInfo(
                "cmd.exe",
                "/d /s /c \"\"" + bun + "\" src\\server.ts >> \".logs\\hub.log\" 2>&1\"");
            info.WorkingDirectory = Root;
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            lock (guard)
            {
                started = Process.Start(info);
                startedBun = bun;
            }
        }

        /// <summary>Stops only the hub and its launcher. Project services and Inference keep running.</summary>
        public void Stop(Health health)
        {
            Process mine;
            string bun;
            lock (guard)
            {
                mine = started;
                bun = startedBun;
                started = null;
                startedBun = null;
            }
            // Read the direct hub child before stopping either process: a silent health endpoint must not leave
            // Bun behind, while recursively walking the launcher would reach Inference and other services.
            List<Process> children = DirectHubs(mine, bun ?? FindBun());
            if (health != null && health.Up && health.Pid > 0)
            {
                try
                {
                    StopProcess(Process.GetProcessById(health.Pid));
                }
                catch (Exception)
                {
                    // It has already ended.
                }
            }
            foreach (Process child in children)
            {
                StopProcess(child);
            }
            StopProcess(mine);
        }

        /// <summary>Only this launcher's direct Bun child, validated against its executable and creation time.</summary>
        private static List<Process> DirectHubs(Process launcher, string bun)
        {
            var children = new List<Process>();
            if (launcher == null || bun == null)
            {
                return children;
            }
            try
            {
                if (launcher.HasExited) { return children; }
                DateTime began = launcher.StartTime.ToUniversalTime();
                int parent = launcher.Id;
                IntPtr snapshot = CreateToolhelp32Snapshot(2, 0); // TH32CS_SNAPPROCESS
                if (snapshot == new IntPtr(-1)) { return children; }
                try
                {
                    var entry = new ProcessEntry { Size = (uint)Marshal.SizeOf(typeof(ProcessEntry)) };
                    if (!Process32First(snapshot, ref entry)) { return children; }
                    do
                    {
                        if (entry.Parent != parent || !string.Equals(entry.Executable, "bun.exe", StringComparison.OrdinalIgnoreCase))
                        {
                            continue;
                        }
                        Process child = null;
                        try
                        {
                            child = Process.GetProcessById((int)entry.Pid);
                            if (!child.HasExited && child.StartTime.ToUniversalTime() >= began
                                && string.Equals(Path.GetFullPath(child.MainModule.FileName), Path.GetFullPath(bun), StringComparison.OrdinalIgnoreCase))
                            {
                                children.Add(child);
                                child = null; // The caller now owns this handle.
                            }
                        }
                        catch (Exception)
                        {
                            // A disappeared, reused or inaccessible PID does not establish ownership.
                        }
                        finally
                        {
                            if (child != null) { child.Dispose(); }
                        }
                    } while (Process32Next(snapshot, ref entry));
                }
                finally
                {
                    CloseHandle(snapshot);
                }
            }
            catch (Exception)
            {
                // The launcher already ended or cannot be inspected: no other process may be inferred as ours.
            }
            return children;
        }

        private static void StopProcess(Process process)
        {
            if (process == null) { return; }
            try
            {
                if (!process.HasExited) { process.Kill(); }
                process.WaitForExit(5000);
            }
            catch (Exception)
            {
                // It has already ended.
            }
            finally
            {
                process.Dispose();
            }
        }

        public void OpenPage()
        {
            Process.Start(new ProcessStartInfo(Url) { UseShellExecute = true });
        }

        private static string FindBun()
        {
            string path = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (string dir in path.Split(';'))
            {
                string clean = dir.Trim().Trim('"');
                if (clean.Length == 0)
                {
                    continue;
                }
                try
                {
                    string candidate = Path.Combine(clean, "bun.exe");
                    if (File.Exists(candidate))
                    {
                        return candidate;
                    }
                }
                catch (ArgumentException)
                {
                    // A PATH entry that is not a path.
                }
            }
            string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            string installed = Path.Combine(home, ".bun\\bin\\bun.exe");
            return File.Exists(installed) ? installed : null;
        }
    }

    /// <summary>Starting with Windows: this user's Run key, and Task Manager's switch for it.</summary>
    internal static class Autostart
    {
        private const string ApprovedKey = "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";
        private const string Name = "Пульт";
        private const string RunKey = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";

        public static bool Enabled
        {
            get
            {
                using (var run = Registry.CurrentUser.OpenSubKey(RunKey))
                {
                    if (run == null || run.GetValue(Name) == null)
                    {
                        return false;
                    }
                }
                using (var approved = Registry.CurrentUser.OpenSubKey(ApprovedKey))
                {
                    // Task Manager marks an entry it switched off with an odd first byte.
                    var mark = approved == null ? null : approved.GetValue(Name) as byte[];
                    return mark == null || mark.Length == 0 || mark[0] % 2 == 0;
                }
            }
        }

        public static void Set(bool on)
        {
            using (var run = Registry.CurrentUser.CreateSubKey(RunKey))
            {
                if (on)
                {
                    run.SetValue(Name, "\"" + Application.ExecutablePath + "\" --background");
                }
                else
                {
                    run.DeleteValue(Name, false);
                }
            }
            using (var approved = Registry.CurrentUser.OpenSubKey(ApprovedKey, true))
            {
                if (approved != null)
                {
                    approved.DeleteValue(Name, false);
                }
            }
        }
    }

    /// <summary>
    /// The picture: a colour wheel like the mark on the hub's page (green, blue, amber) around a dark core, a knob of
    /// a remote. Grey while the hub does not answer.
    /// </summary>
    internal static class Icons
    {
        private const int Master = 256;
        private const int Slices = 180;
        private static readonly Color Core = Color.FromArgb(255, 0x15, 0x12, 0x1a);
        private static readonly int[] IcoSizes = { 16, 20, 24, 32, 40, 48, 64, 256 };
        private static readonly Color[] Stops =
        {
            Color.FromArgb(255, 0x34, 0xd3, 0x99),
            Color.FromArgb(255, 0x60, 0xa5, 0xfa),
            Color.FromArgb(255, 0xfb, 0xbf, 0x24),
            Color.FromArgb(255, 0x34, 0xd3, 0x99),
        };

        public static Bitmap Draw(bool up)
        {
            var bitmap = new Bitmap(Master, Master, PixelFormat.Format32bppArgb);
            using (var g = Graphics.FromImage(bitmap))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.Clear(Color.Transparent);
                const float pad = 8f;
                const float size = Master - 2 * pad;
                for (int i = 0; i < Slices; i++)
                {
                    float t = (float)i / Slices;
                    using (var brush = new SolidBrush(Wheel(t, up)))
                    {
                        // Each slice a little wider than its share, so no seams show between them.
                        g.FillPie(brush, pad, pad, size, size, -90f + t * 360f, 360f / Slices + 1f);
                    }
                }
                const float core = Master * 0.44f;
                using (var brush = new SolidBrush(Core))
                {
                    g.FillEllipse(brush, (Master - core) / 2f, (Master - core) / 2f, core, core);
                }
            }
            return bitmap;
        }

        public static Bitmap Scale(Bitmap master, int size)
        {
            var bitmap = new Bitmap(size, size, PixelFormat.Format32bppArgb);
            using (var g = Graphics.FromImage(bitmap))
            {
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.DrawImage(master, 0, 0, size, size);
            }
            return bitmap;
        }

        /// <summary>The tray's icon at the size the screen's scale asks for.</summary>
        public static Icon Tray(bool up)
        {
            int size = SystemInformation.SmallIconSize.Width;
            using (var master = Draw(up))
            using (var small = Scale(master, size))
            {
                return Icon.FromHandle(small.GetHicon());
            }
        }

        /// <summary>Writes an .ico with every usual size (PNG inside, as Windows reads since Vista) and a .png beside it.</summary>
        public static void WriteIco(string path)
        {
            var images = new List<byte[]>();
            using (var master = Draw(true))
            {
                foreach (int size in IcoSizes)
                {
                    using (var bitmap = Scale(master, size))
                    using (var stream = new MemoryStream())
                    {
                        bitmap.Save(stream, ImageFormat.Png);
                        images.Add(stream.ToArray());
                    }
                }
                master.Save(Path.ChangeExtension(path, ".png"), ImageFormat.Png);
            }
            using (var file = new BinaryWriter(File.Create(path)))
            {
                file.Write((short)0);
                file.Write((short)1);
                file.Write((short)IcoSizes.Length);
                int offset = 6 + 16 * IcoSizes.Length;
                for (int i = 0; i < IcoSizes.Length; i++)
                {
                    byte side = (byte)(IcoSizes[i] >= 256 ? 0 : IcoSizes[i]);
                    file.Write(side);
                    file.Write(side);
                    file.Write((byte)0);
                    file.Write((byte)0);
                    file.Write((short)1);
                    file.Write((short)32);
                    file.Write(images[i].Length);
                    file.Write(offset);
                    offset += images[i].Length;
                }
                foreach (byte[] image in images)
                {
                    file.Write(image);
                }
            }
        }

        private static Color Wheel(float t, bool up)
        {
            float scaled = t * (Stops.Length - 1);
            int index = Math.Min((int)scaled, Stops.Length - 2);
            float f = scaled - index;
            Color a = Stops[index];
            Color b = Stops[index + 1];
            int red = (int)(a.R + (b.R - a.R) * f);
            int green = (int)(a.G + (b.G - a.G) * f);
            int blue = (int)(a.B + (b.B - a.B) * f);
            if (up)
            {
                return Color.FromArgb(255, red, green, blue);
            }
            // Grey of the same lightness, pulled towards the page's grey for stopped services.
            int grey = ((int)(0.3 * red + 0.59 * green + 0.11 * blue) + 0x57) / 2;
            return Color.FromArgb(255, grey, grey, grey);
        }
    }

    /// <summary>
    /// The tray: the icon and its menu. It asks the hub every few seconds whether it runs, starts it when it does not
    /// (three tries in five minutes, then it says so and waits), and opens its control window when asked. While the hub runs,
    /// the menu also carries the shared queue's lines exactly as the hub words them.
    /// </summary>
    internal sealed class TrayApp : ApplicationContext
    {
        private const int BalloonLimit = 250;
        private const int MaxStarts = 3;
        private const int PollMs = 3000;
        private const int StartGraceSeconds = 30;
        private const int StartWindowMinutes = 5;
        private const int TipLimit = 63;

        private readonly ToolStripMenuItem autostart;
        private readonly Icon downIcon;
        private readonly Hub hub;
        private readonly NotifyIcon icon;
        private readonly ContextMenuStrip menu;
        private readonly ControlWindow window;
        private readonly List<ToolStripItem> queueItems = new List<ToolStripItem>();
        private readonly List<DateTime> starts = new List<DateTime>();
        private readonly ToolStripMenuItem status;
        private readonly System.Windows.Forms.Timer timer;
        private readonly Control ui;
        private readonly Icon upIcon;
        private bool checking;
        private bool closing;
        private bool keepRunning = true;
        private Health last = new Health();
        private bool openWebWhenUp;
        private bool actionPending;
        private bool restarting;
        private bool stopping;
        private int readingEpoch;
        private string commandError = "";
        private bool pollAgain;
        private QueueMenu queueLatest = new QueueMenu();
        private string queueShown = "";
        private DateTime startedAt = DateTime.MinValue;

        public TrayApp(Hub hub, Signals signals, bool open)
        {
            this.hub = hub;
            ui = new Control();
            // Answers from other threads come back through this control: it needs its window now.
            if (ui.Handle == IntPtr.Zero)
            {
                throw new InvalidOperationException("no window to receive answers on");
            }
            upIcon = Icons.Tray(true);
            downIcon = Icons.Tray(false);
            window = new ControlWindow();
            window.StartRequested += StartRequested;
            window.StopRequested += StopHub;
            window.RestartRequested += Restart;
            window.OpenWebRequested += OpenWebPanel;
            window.LogsRequested += OpenLogs;
            window.RefreshRequested += Poll;
            window.QueueCommandRequested += SendQueue;

            menu = new ContextMenuStrip();
            menu.ShowItemToolTips = true;
            var openItem = new ToolStripMenuItem("Управление DevHub и Inference", null, delegate { OpenRequested(); });
            openItem.Font = new Font(openItem.Font, FontStyle.Bold);
            status = new ToolStripMenuItem("Проверяю пульт…");
            status.Enabled = false;
            var restart = new ToolStripMenuItem("Перезапустить пульт", null, delegate { Restart(); });
            restart.ToolTipText = "Серверы проектов при этом продолжают работать";
            var logs = new ToolStripMenuItem("Папка с логами", null, delegate { OpenLogs(); });
            var web = new ToolStripMenuItem("Открыть веб-панель", null, delegate { OpenWebPanel(); });
            autostart = new ToolStripMenuItem("Запускать при входе в Windows", null, delegate { ToggleAutostart(); });
            var exit = new ToolStripMenuItem("Выход", null, delegate { Exit(); });
            exit.ToolTipText = "Убрать значок и остановить пульт; серверы проектов продолжат работать";
            menu.Items.AddRange(new ToolStripItem[]
            {
                openItem, status, new ToolStripSeparator(), restart, web, logs, autostart, new ToolStripSeparator(), exit,
            });
            menu.Opening += delegate
            {
                autostart.Checked = Autostart.Enabled;
                Poll();
            };
            // What the hub said while the menu was open is drawn once it has closed and its click is handled.
            menu.Closed += delegate { Post(ShowQueue); };

            icon = new NotifyIcon();
            icon.Icon = downIcon;
            SetTip("Пульт: проверяю…");
            icon.ContextMenuStrip = menu;
            icon.MouseClick += (sender, e) =>
            {
                if (e.Button == MouseButtons.Left)
                {
                    OpenRequested();
                }
            };
            icon.Visible = true;

            var listener = new Thread(() => Listen(signals.Handles));
            listener.IsBackground = true;
            listener.Start();

            timer = new System.Windows.Forms.Timer();
            timer.Interval = PollMs;
            timer.Tick += delegate { Poll(); };
            timer.Start();
            Poll();
            if (open) { Post(OpenRequested); }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                timer.Dispose();
                window.Dispose();
                icon.Dispose();
                menu.Dispose();
                ui.Dispose();
            }
            base.Dispose(disposing);
        }

        private static string Clip(string text)
        {
            return text.Length <= TipLimit ? text : text.Substring(0, TipLimit - 1) + "…";
        }

        private void SetTip(string text)
        {
            icon.Text = Clip(text);
        }

        private void ApplyWindow()
        {
            window.ApplyState(last, queueLatest, status.Text, actionPending || restarting, commandError);
        }

        /// <summary>
        /// The tooltip with the queue's words after the hub's. It holds 63 characters: when both do not fit, the
        /// hub's part is said shorter, so the queue's state is not the part that is cut.
        /// </summary>
        private static string WithQueue(string text, int managed, string tip)
        {
            if (tip.Length == 0)
            {
                return Clip(text);
            }
            string full = text + "; " + tip;
            if (full.Length <= TipLimit)
            {
                return full;
            }
            // Active progress comes first so even the native tooltip cannot cut off its measured percentage.
            return Clip(tip + "; " + (managed > 0 ? "Пульт: " + Servers(managed) : "Пульт"));
        }

        private static string Servers(int n)
        {
            int tens = n % 100;
            int units = n % 10;
            string word = "серверов";
            if (tens < 11 || tens > 19)
            {
                if (units == 1)
                {
                    word = "сервер";
                }
                else if (units >= 2 && units <= 4)
                {
                    word = "сервера";
                }
            }
            return n + " " + word;
        }

        private void Listen(WaitHandle[] handles)
        {
            try
            {
                while (true)
                {
                    int which = WaitHandle.WaitAny(handles);
                    if (which == 0)
                    {
                        Post(OpenRequested);
                    }
                    else if (which == 1)
                    {
                        Post(CloseTray);
                    }
                    else if (which == 2)
                    {
                        Post(Exit);
                    }
                    else if (which == 3)
                    {
                        Post(StartRequested);
                    }
                    else
                    {
                        Post(Restart);
                    }
                }
            }
            catch (ObjectDisposedException)
            {
                // The program is closing.
            }
        }

        private void Post(Action action)
        {
            if (closing || !ui.IsHandleCreated)
            {
                return;
            }
            try
            {
                ui.BeginInvoke(action);
            }
            catch (InvalidOperationException)
            {
                // The program is closing.
            }
        }

        private void Poll()
        {
            if (closing)
            {
                return;
            }
            if (checking)
            {
                // The answer under way may be older than what was just done: ask once more after it.
                pollAgain = true;
                return;
            }
            checking = true;
            int epoch = readingEpoch;
            ThreadPool.QueueUserWorkItem(delegate
            {
                Health health = hub.Check();
                QueueMenu queue = health.Up ? hub.ReadQueueMenu() : new QueueMenu();
                Post(() =>
                {
                    if (epoch != readingEpoch)
                    {
                        checking = false;
                        pollAgain = false;
                        Poll();
                        return;
                    }
                    Apply(health, queue);
                });
            });
        }

        private void Apply(Health health, QueueMenu queue)
        {
            checking = false;
            last = health;
            queueLatest = queue;
            ShowQueue();
            ShowHealth(health, queue.Tip);
            ApplyWindow();
            if (pollAgain)
            {
                pollAgain = false;
                Poll();
            }
        }

        /// <summary>
        /// Draws the queue's part of the menu, between the hub's state and its own commands, when the hub's answer
        /// changed. An open menu is left as it is: its items must not move or vanish under the pointer.
        /// </summary>
        private void ShowQueue()
        {
            QueueMenu queue = queueLatest;
            if (closing || menu.Visible || queue.Json == queueShown)
            {
                return;
            }
            queueShown = queue.Json;
            menu.SuspendLayout();
            foreach (ToolStripItem old in queueItems)
            {
                menu.Items.Remove(old);
                old.Dispose();
            }
            queueItems.Clear();
            if (queue.Items.Count > 0)
            {
                // The separator that follows the section is the menu's own, before «Перезапустить пульт».
                queueItems.Add(new ToolStripSeparator());
                foreach (QueueItem entry in queue.Items)
                {
                    queueItems.Add(QueueMenuItem(entry));
                }
                int at = menu.Items.IndexOf(status) + 1;
                foreach (ToolStripItem item in queueItems)
                {
                    menu.Items.Insert(at, item);
                    at++;
                }
            }
            menu.ResumeLayout();
        }

        private ToolStripItem QueueMenuItem(QueueItem entry)
        {
            if (entry.Separator)
            {
                return new ToolStripSeparator();
            }
            // An ampersand would otherwise underline the next letter.
            var item = new ToolStripMenuItem(entry.Text.Replace("&", "&&"));
            item.Enabled = entry.Enabled;
            item.Checked = entry.Checked;
            if (entry.Post != null)
            {
                string path = entry.Post;
                item.Click += delegate { SendQueue(path); };
            }
            else if (entry.Open != null)
            {
                string url = entry.Open;
                item.Click += delegate { OpenQueue(url); };
            }
            return item;
        }

        /// <summary>Sends a queue command to the hub, says what went wrong if anything did, and reads the state anew.</summary>
        private void SendQueue(string path)
        {
            if (actionPending || restarting) { return; }
            actionPending = true;
            readingEpoch++;
            commandError = "";
            ApplyWindow();
            ThreadPool.QueueUserWorkItem(delegate
            {
                string error = hub.Command(path);
                Post(() =>
                {
                    actionPending = false;
                    readingEpoch++;
                    commandError = error ?? "";
                    if (!string.IsNullOrEmpty(error))
                    {
                        string text = error.Length <= BalloonLimit ? error : error.Substring(0, BalloonLimit - 1) + "…";
                        icon.ShowBalloonTip(8000, "Общая очередь", text, ToolTipIcon.Warning);
                    }
                    ApplyWindow();
                    Poll();
                });
            });
        }

        private void OpenQueue(string url)
        {
            if (!hub.Owns(url))
            {
                return;
            }
            try
            {
                Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
            }
            catch (Exception error)
            {
                icon.ShowBalloonTip(5000, "Общая очередь", "Не удалось открыть страницу: " + error.Message, ToolTipIcon.Warning);
            }
        }

        private void ShowHealth(Health health, string queueTip)
        {
            if (restarting || stopping)
            {
                string words = restarting ? "Пульт перезапускается…" : "Пульт останавливается…";
                SetTip(words);
                status.Text = words;
                return;
            }
            if (health.Up)
            {
                icon.Icon = upIcon;
                if (health.Managed > 0)
                {
                    SetTip(WithQueue("Пульт работает; из него запущено " + Servers(health.Managed), health.Managed, queueTip));
                    status.Text = "Работает; из пульта запущено " + Servers(health.Managed);
                }
                else
                {
                    SetTip(WithQueue("Пульт работает", 0, queueTip));
                    status.Text = "Пульт работает";
                }
                if (openWebWhenUp)
                {
                    openWebWhenUp = false;
                    OpenWebPanel();
                }
                return;
            }
            icon.Icon = downIcon;
            if ((DateTime.Now - startedAt).TotalSeconds < StartGraceSeconds)
            {
                SetTip("Пульт запускается…");
                status.Text = "Пульт запускается…";
                return;
            }
            if (!keepRunning)
            {
                SetTip("Пульт остановлен");
                status.Text = "Пульт остановлен";
                return;
            }
            StartHub();
        }

        private void StartHub()
        {
            starts.RemoveAll(at => (DateTime.Now - at).TotalMinutes > StartWindowMinutes);
            if (starts.Count >= MaxStarts)
            {
                keepRunning = false;
                SetTip("Пульт не запускается");
                status.Text = "Не запускается: смотрите лог";
                icon.ShowBalloonTip(
                    10000,
                    "Пульт не запускается",
                    "Три попытки за пять минут не удались. Что пошло не так, видно в .logs\\hub.log; когда поправите, выберите «Перезапустить пульт».",
                    ToolTipIcon.Error);
                return;
            }
            try
            {
                hub.Start();
                starts.Add(DateTime.Now);
                startedAt = DateTime.Now;
                SetTip("Пульт запускается…");
                status.Text = "Пульт запускается…";
            }
            catch (Exception error)
            {
                keepRunning = false;
                SetTip("Пульт не запускается");
                status.Text = "Не запускается";
                icon.ShowBalloonTip(10000, "Пульт не запускается", error.Message, ToolTipIcon.Error);
            }
        }

        private void OpenRequested()
        {
            ApplyWindow();
            window.Open();
            Poll();
        }

        /// <summary>Only an explicit web-panel command opens a browser.</summary>
        private void OpenWebPanel()
        {
            if (!last.Up)
            {
                openWebWhenUp = true;
                StartRequested();
                return;
            }
            try { hub.OpenPage(); }
            catch (Exception error)
            {
                commandError = "Не удалось открыть веб-панель: " + error.Message;
                ApplyWindow();
            }
        }

        /// <summary>
        /// The hub is wanted now: by a click here, or by a command-line client that found it silent. Started from
        /// here it runs in the person's own session, whatever app that client was itself started from.
        /// </summary>
        private void StartRequested()
        {
            if (restarting || actionPending) { return; }
            commandError = "";
            if (!keepRunning)
            {
                keepRunning = true;
                starts.Clear();
            }
            Poll();
        }

        private void Restart()
        {
            if (restarting || actionPending) { return; }
            restarting = true;
            readingEpoch++;
            commandError = "";
            // No starting on its own while it stops.
            keepRunning = false;
            Health health = last;
            SetTip("Пульт перезапускается…");
            status.Text = "Перезапускается…";
            ApplyWindow();
            ThreadPool.QueueUserWorkItem(delegate
            {
                hub.Stop(health);
                // The port is let go a moment after the process ends.
                for (int i = 0; i < 20 && hub.Check().Up; i++)
                {
                    Thread.Sleep(500);
                }
                Post(() =>
                {
                    last = new Health();
                    readingEpoch++;
                    keepRunning = true;
                    starts.Clear();
                    startedAt = DateTime.MinValue;
                    StartHub();
                    restarting = false;
                    ApplyWindow();
                    Poll();
                });
            });
        }

        private void StopHub()
        {
            if (restarting || actionPending) { return; }
            keepRunning = false;
            stopping = true;
            actionPending = true;
            readingEpoch++;
            commandError = "";
            status.Text = "Останавливается…";
            SetTip("Пульт останавливается…");
            ApplyWindow();
            Health health = last;
            ThreadPool.QueueUserWorkItem(delegate
            {
                hub.Stop(health);
                Post(() =>
                {
                    actionPending = false;
                    stopping = false;
                    readingEpoch++;
                    last = new Health();
                    startedAt = DateTime.MinValue;
                    queueLatest = new QueueMenu();
                    ShowHealth(last, "");
                    ApplyWindow();
                    Poll();
                });
            });
        }

        private void OpenLogs()
        {
            Directory.CreateDirectory(hub.Logs);
            Process.Start("explorer.exe", "\"" + hub.Logs + "\"");
        }

        private void ToggleAutostart()
        {
            try
            {
                Autostart.Set(!Autostart.Enabled);
            }
            catch (Exception error)
            {
                icon.ShowBalloonTip(5000, "Пульт", "Не удалось поменять автозапуск: " + error.Message, ToolTipIcon.Warning);
            }
            autostart.Checked = Autostart.Enabled;
        }

        /// <summary>Closes the tray alone: the hub keeps running (so the program can be replaced by a new build).</summary>
        private void CloseTray()
        {
            window.Hide();
            closing = true;
            timer.Stop();
            icon.Visible = false;
            ExitThread();
        }

        /// <summary>The menu's «Выход»: the tray goes, and the hub with it; the servers it started keep running.</summary>
        private void Exit()
        {
            window.Hide();
            closing = true;
            timer.Stop();
            icon.Visible = false;
            hub.Stop(last);
            ExitThread();
        }
    }
}
