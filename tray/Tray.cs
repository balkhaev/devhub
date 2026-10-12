// «Пульт» в трее: значок, который открывает пульт в браузере, держит его запущенным и включает автозапуск.
// Пока пульт работает, в меню есть и общая очередь GPU/CPU: её состояние, «Стоп», «Пауза», «Продолжить»
// и исполнители. Эти пункты пульт присылает готовыми (GET api/queue/tray), значок их только рисует
// и отправляет нажатия обратно в пульт: об очереди он сам ничего не знает.
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

        public static QueueMenu Parse(string json)
        {
            var menu = new QueueMenu();
            try
            {
                var data = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(json);
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

    /// <summary>The hub's server: where it lives, whether it answers, starting and stopping it.</summary>
    internal sealed class Hub
    {
        public readonly int Port;
        public readonly string Root;
        private readonly object guard = new object();
        private Process started;
        private string token = "";

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
    /// (three tries in five minutes, then it says so and waits), and opens the page when asked. While the hub runs,
    /// the menu also carries the shared queue's lines exactly as the hub words them.
    /// </summary>
    internal sealed class TrayApp : ApplicationContext
    {
        private const int BalloonLimit = 250;
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
        private bool openWhenUp;
        private bool pollAgain;
        private QueueMenu queueLatest = new QueueMenu();
        private string queueShown = "";
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
            // What the hub said while the menu was open is drawn once it has closed and its click is handled.
            menu.Closed += delegate { Post(ShowQueue); };

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
            return Clip((managed > 0 ? "Пульт: " + Servers(managed) : "Пульт") + "; " + tip);
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
            ThreadPool.QueueUserWorkItem(delegate
            {
                Health health = hub.Check();
                QueueMenu queue = health.Up ? hub.ReadQueueMenu() : new QueueMenu();
                Post(() => Apply(health, queue));
            });
        }

        private void Apply(Health health, QueueMenu queue)
        {
            checking = false;
            last = health;
            queueLatest = queue;
            ShowQueue();
            ShowHealth(health, queue.Tip);
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
            ThreadPool.QueueUserWorkItem(delegate
            {
                string error = hub.Command(path);
                Post(() =>
                {
                    if (!string.IsNullOrEmpty(error))
                    {
                        string text = error.Length <= BalloonLimit ? error : error.Substring(0, BalloonLimit - 1) + "…";
                        icon.ShowBalloonTip(8000, "Общая очередь", text, ToolTipIcon.Warning);
                    }
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
            if (health.Up)
            {
                icon.Icon = upIcon;
                if (health.Managed > 0)
                {
                    icon.Text = WithQueue("Пульт работает; из него запущено " + Servers(health.Managed), health.Managed, queueTip);
                    status.Text = "Работает; из пульта запущено " + Servers(health.Managed);
                }
                else
                {
                    icon.Text = WithQueue("Пульт работает", 0, queueTip);
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
