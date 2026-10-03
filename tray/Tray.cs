// «Пульт» в трее: значок, который открывает пульт в браузере, держит его запущенным и включает автозапуск.
// Собирается компилятором C# из .NET Framework 4, который есть в каждой Windows (scripts/install-windows.ps1),
// поэтому написан на C# 5: другого этот компилятор не знает.

using System;
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
        /// Without arguments: the tray, and the page once the hub answers. <c>--background</c>: the tray alone (at
        /// sign-in). A second copy passes its wish to the running one: open the page, <c>--close</c> the tray
        /// (the hub keeps running), <c>--stop</c> the tray and the hub. <c>--write-icon file.ico</c> draws the icon.
        /// </summary>
        [STAThread]
        private static int Main(string[] args)
        {
            if (args.Length == 2 && args[0] == "--write-icon")
            {
                Icons.WriteIco(args[1]);
                return 0;
            }
            bool background = Array.IndexOf(args, "--background") >= 0;
            bool close = Array.IndexOf(args, "--close") >= 0;
            bool stop = Array.IndexOf(args, "--stop") >= 0;
            bool first;
            using (var mutex = new Mutex(true, MutexName, out first))
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
            return 0;
        }
    }

    /// <summary>Named events through which a second copy of the program asks the running one to act.</summary>
    internal sealed class Signals : IDisposable
    {
        public const string Open = "Local\\DevhubTray.Open";
        public const string Close = "Local\\DevhubTray.Close";
        public const string Stop = "Local\\DevhubTray.Stop";

        public readonly EventWaitHandle[] Handles;

        public Signals()
        {
            Handles = new[]
            {
                new EventWaitHandle(false, EventResetMode.AutoReset, Open),
                new EventWaitHandle(false, EventResetMode.AutoReset, Close),
                new EventWaitHandle(false, EventResetMode.AutoReset, Stop),
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

    /// <summary>The hub's server: where it lives, whether it answers, starting and stopping it.</summary>
    internal sealed class Hub
    {
        public readonly int Port;
        public readonly string Root;
        private readonly object guard = new object();
        private Process started;

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
            }
        }

        /// <summary>Stops the hub: the process that answers as the hub, and the one this program started.</summary>
        public void Stop(Health health)
        {
            if (health != null && health.Up && health.Pid > 0)
            {
                try
                {
                    Process.GetProcessById(health.Pid).Kill();
                }
                catch (Exception)
                {
                    // It has already ended.
                }
            }
            Process mine;
            lock (guard)
            {
                mine = started;
                started = null;
            }
            if (mine == null)
            {
                return;
            }
            try
            {
                if (!mine.HasExited)
                {
                    KillTree(mine.Id);
                }
            }
            catch (Exception)
            {
                // It has already ended.
            }
        }

        public void OpenPage()
        {
            Process.Start(new ProcessStartInfo(Url) { UseShellExecute = true });
        }

        private static void KillTree(int pid)
        {
            var info = new ProcessStartInfo("taskkill", "/PID " + pid + " /T /F");
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            using (var kill = Process.Start(info))
            {
                kill.WaitForExit(5000);
            }
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
    /// (three tries in five minutes, then it says so and waits), and opens the page when asked.
    /// </summary>
    internal sealed class TrayApp : ApplicationContext
    {
        private const int MaxStarts = 3;
        private const int PollMs = 5000;
        private const int StartGraceSeconds = 30;
        private const int StartWindowMinutes = 5;
        private const int TipLimit = 63;

        private readonly ToolStripMenuItem autostart;
        private readonly Icon downIcon;
        private readonly Hub hub;
        private readonly NotifyIcon icon;
        private readonly ContextMenuStrip menu;
        private readonly List<DateTime> starts = new List<DateTime>();
        private readonly ToolStripMenuItem status;
        private readonly System.Windows.Forms.Timer timer;
        private readonly Control ui;
        private readonly Icon upIcon;
        private bool checking;
        private bool closing;
        private bool keepRunning = true;
        private Health last = new Health();
        private bool openWhenUp;
        private DateTime startedAt = DateTime.MinValue;

        public TrayApp(Hub hub, Signals signals, bool open)
        {
            this.hub = hub;
            openWhenUp = open;
            ui = new Control();
            // Answers from other threads come back through this control: it needs its window now.
            if (ui.Handle == IntPtr.Zero)
            {
                throw new InvalidOperationException("no window to receive answers on");
            }
            upIcon = Icons.Tray(true);
            downIcon = Icons.Tray(false);

            menu = new ContextMenuStrip();
            menu.ShowItemToolTips = true;
            var openItem = new ToolStripMenuItem("Открыть пульт", null, delegate { OpenRequested(); });
            openItem.Font = new Font(openItem.Font, FontStyle.Bold);
            status = new ToolStripMenuItem("Проверяю пульт…");
            status.Enabled = false;
            var restart = new ToolStripMenuItem("Перезапустить пульт", null, delegate { Restart(); });
            restart.ToolTipText = "Серверы проектов при этом продолжают работать";
            var logs = new ToolStripMenuItem("Папка с логами", null, delegate { OpenLogs(); });
            autostart = new ToolStripMenuItem("Запускать при входе в Windows", null, delegate { ToggleAutostart(); });
            var exit = new ToolStripMenuItem("Выход", null, delegate { Exit(); });
            exit.ToolTipText = "Убрать значок и остановить пульт; серверы проектов продолжат работать";
            menu.Items.AddRange(new ToolStripItem[]
            {
                openItem, status, new ToolStripSeparator(), restart, logs, autostart, new ToolStripSeparator(), exit,
            });
            menu.Opening += delegate { autostart.Checked = Autostart.Enabled; };

            icon = new NotifyIcon();
            icon.Icon = downIcon;
            icon.Text = "Пульт: проверяю…";
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
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                timer.Dispose();
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
                    else
                    {
                        Post(Exit);
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
            if (checking || closing)
            {
                return;
            }
            checking = true;
            ThreadPool.QueueUserWorkItem(delegate
            {
                Health health = hub.Check();
                Post(() => Apply(health));
            });
        }

        private void Apply(Health health)
        {
            checking = false;
            last = health;
            if (health.Up)
            {
                icon.Icon = upIcon;
                if (health.Managed > 0)
                {
                    icon.Text = Clip("Пульт работает; из него запущено " + Servers(health.Managed));
                    status.Text = "Работает; из пульта запущено " + Servers(health.Managed);
                }
                else
                {
                    icon.Text = "Пульт работает";
                    status.Text = "Пульт работает";
                }
                if (openWhenUp)
                {
                    openWhenUp = false;
                    hub.OpenPage();
                }
                return;
            }
            icon.Icon = downIcon;
            if ((DateTime.Now - startedAt).TotalSeconds < StartGraceSeconds)
            {
                icon.Text = "Пульт запускается…";
                status.Text = "Пульт запускается…";
                return;
            }
            if (!keepRunning)
            {
                icon.Text = "Пульт остановлен";
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
                icon.Text = "Пульт не запускается";
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
                icon.Text = "Пульт запускается…";
                status.Text = "Пульт запускается…";
            }
            catch (Exception error)
            {
                keepRunning = false;
                icon.Text = "Пульт не запускается";
                status.Text = "Не запускается";
                icon.ShowBalloonTip(10000, "Пульт не запускается", error.Message, ToolTipIcon.Error);
            }
        }

        private void OpenRequested()
        {
            if (last.Up)
            {
                hub.OpenPage();
                return;
            }
            openWhenUp = true;
            if (!keepRunning)
            {
                keepRunning = true;
                starts.Clear();
            }
            Poll();
        }

        private void Restart()
        {
            // No starting on its own while it stops.
            keepRunning = false;
            Health health = last;
            icon.Text = "Пульт перезапускается…";
            status.Text = "Перезапускается…";
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
                    keepRunning = true;
                    starts.Clear();
                    startedAt = DateTime.MinValue;
                    StartHub();
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
            closing = true;
            timer.Stop();
            icon.Visible = false;
            ExitThread();
        }

        /// <summary>The menu's «Выход»: the tray goes, and the hub with it; the servers it started keep running.</summary>
        private void Exit()
        {
            closing = true;
            timer.Stop();
            icon.Visible = false;
            hub.Stop(last);
            ExitThread();
        }
    }
}
