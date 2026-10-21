using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace Devhub
{
    /// <summary>Runs the actual native tray code without starting a tray, a hub or any project service.</summary>
    internal static class TrayHarness
    {
        [STAThread]
        private static int Main(string[] args)
        {
            if (args[0] != "heartbeat") { Console.OutputEncoding = System.Text.Encoding.UTF8; }
            try
            {
                switch (args[0])
                {
                    case "heartbeat": Heartbeat(args[1]); break;
                    case "parser": Parser(); break;
                    case "lifecycle": Lifecycle(args[1], args[2]); break;
                    case "queue-view": View(args.Length > 2 ? args[2] : null); break;
                    case "full-queue": FullQueue(args.Length > 2 ? args[2] : null); break;
                    case "window": Window(args.Length > 2 ? args[2] : null); break;
                    case "actions": Actions(); break;
                    case "projects": Projects(); break;
                    default: throw new InvalidOperationException("Unknown harness mode");
                }
                return 0;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(error);
                return 1;
            }
        }

        private static void Require(bool condition, string message)
        {
            if (!condition)
            {
                throw new InvalidOperationException(message);
            }
        }

        private static Dictionary<string, object> Status()
        {
            return new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(
                "{\"running\":2,\"jobs\":[{\"id\":\"job-1\",\"name\":\"Рендер сцены\","
                + "\"resource\":\"gpu\",\"private\":false,\"progress\":{\"percent\":37.5,\"step\":3,\"totalSteps\":8,"
                + "\"phaseTitle\":\"Рендер\",\"scope\":\"node\"}},"
                + "{\"id\":\"job-2\",\"name\":\"Подготовка данных\",\"resource\":\"cpu\",\"private\":false}],"
                + "\"queued\":2,\"queuedJobs\":[{\"id\":\"wait-1\",\"name\":\"Следующая сцена\",\"resource\":\"gpu\",\"private\":false},"
                + "{\"id\":\"wait-2\",\"name\":\"Проверка результата\",\"resource\":\"cpu\",\"private\":false}],"
                + "\"label\":\"Выполняется: 2\",\"state\":\"working\","
                + "\"gpu\":{\"name\":\"RTX 4090\",\"temperature\":67,\"totalMb\":24576,\"usedMb\":9216,\"utilization\":83},"
                + "\"host\":{\"cpu\":42,\"availableMb\":24576,\"totalMb\":65536}}");
        }

        private static void Parser()
        {
            var payload = new Dictionary<string, object>
            {
                { "tip", "Inference\r\n37%" },
                { "status", Status() },
                { "items", new object[]
                    {
                        new Dictionary<string, object> { { "text", "Open queue" }, { "enabled", true }, { "open", "http://127.0.0.1:4700/#/inference/queue" } },
                        new Dictionary<string, object> { { "separator", true } },
                        new Dictionary<string, object> { { "text", "Stop queue" }, { "enabled", false }, { "post", "/api/queue/stop" } },
                        null,
                        "invalid item",
                        new Dictionary<string, object> { { "text", "" } },
                    }
                },
            };
            var json = new JavaScriptSerializer().Serialize(payload);
            QueueMenu menu = QueueMenu.Parse(json);
            Require(menu.Json == json, "The tray must retain the latest snapshot identity");
            Require(menu.Tip == "Inference  37%", "Native tooltip must remain a single line");
            Require(menu.Items.Count == 3, "Only valid menu entries should survive parsing");
            Require(menu.Items[0].Enabled && menu.Items[0].Open != null, "Queue link lost");
            Require(menu.Items[1].Separator, "Menu separator lost");
            Require(!menu.Items[2].Enabled && menu.Items[2].Post == "/api/queue/stop", "Queue command changed");
            Require(menu.Status != null && Convert.ToInt32(menu.Status["running"]) == 2,
                "The native tray discarded the widget progress snapshot");
            Require(((IList)menu.Status["queuedJobs"]).Count == 2,
                "The native tray discarded the waiting queue");
            foreach (string broken in new[] { "null", "{", "[]", "\"text\"" })
            {
                QueueMenu empty = QueueMenu.Parse(broken);
                Require(empty.Items.Count == 0 && empty.Status == null && empty.Json == "",
                    "A damaged answer should become an empty menu");
            }
            Require(QueueMenu.Parse("{\"status\":\"invalid\",\"items\":\"invalid\"}").Status == null,
                "An invalid progress snapshot must be ignored");
            ProjectList projects = ProjectList.Parse(
                "{\"projects\":[{\"id\":\"sample\",\"name\":\"Sample\",\"summary\":\"web:5000\","
                + "\"open\":\"http://127.0.0.1:5000/\",\"restart\":true,\"foreign\":false,\"tone\":\"running\"},"
                + "{\"id\":\"../evil\",\"name\":\"Nope\"},{\"name\":\"Missing id\"},null]}");
            Require(projects.Online && projects.Projects.Count == 1 && projects.Projects[0].Id == "sample",
                "Only a safe running project should survive parsing");
            Require(projects.Projects[0].Restart && !projects.Projects[0].Foreign
                && projects.Projects[0].Open == "http://127.0.0.1:5000/",
                "Project card fields were lost");
            Require(!ProjectList.Parse("{").Online && ProjectList.Parse("{\"projects\":[]}").Online
                && ProjectList.Parse("{\"projects\":[]}").Projects.Count == 0,
                "A damaged project list is offline and an empty one is a quiet machine");
        }

        private static void View(string output)
        {
            using (var view = new QueueView())
            {
                Dictionary<string, object> status = Status();
                view.UpdateStatus(status);
                Require(view.Busy, "Active inference must be visible in the window");
                var jobs = (IList)status["jobs"];
                var progress = (Dictionary<string, object>)((Dictionary<string, object>)jobs[0])["progress"];
                string words = QueueView.ProgressWords(progress);
                Require(words.Contains((37.5).ToString("0.#") + "% операции") && words.Contains("шаг 3 из 8"),
                    "The queue view must show the measured percentage, its scope and its steps");
                Require(QueueView.ProgressWords(null) == "Ожидаем данные о прогрессе",
                    "Unknown progress must remain unknown");
                using (var bitmap = new Bitmap(view.Width, view.Height))
                {
                    view.DrawToBitmap(bitmap, new Rectangle(Point.Empty, bitmap.Size));
                    bool filled = false;
                    for (int y = 0; y < bitmap.Height && !filled; y++)
                    {
                        for (int x = 0; x < bitmap.Width && !filled; x++)
                        {
                            filled = bitmap.GetPixel(x, y).ToArgb() == Color.FromArgb(89, 202, 170).ToArgb();
                        }
                    }
                    Require(filled, "The native queue view did not paint the measured progress bar");
                    if (output != null)
                    {
                        bitmap.Save(output, System.Drawing.Imaging.ImageFormat.Png);
                        Console.WriteLine(output);
                    }
                }
                view.UpdateStatus(new Dictionary<string, object>
                {
                    { "running", 0 },
                    { "jobs", new object[0] },
                    { "queued", 0 },
                });
                Require(!view.Busy && view.Visible, "An idle queue must keep its embedded view available");
                using (Bitmap idle = Paint(view))
                {
                    view.UpdateStatus(null);
                    Require(!view.Busy && view.Visible, "An offline queue must keep its embedded view available");
                    using (Bitmap offline = Paint(view))
                    {
                        Require(Different(idle, offline), "An offline queue must not look like a confirmed empty queue");
                    }
                }
                view.UpdateStatus(null);
                Require(!view.Busy, "A missing observation must not leave stale work visible");
            }
        }

        private static Bitmap Paint(QueueView view)
        {
            var bitmap = new Bitmap(view.Width, view.Height);
            view.DrawToBitmap(bitmap, new Rectangle(Point.Empty, bitmap.Size));
            return bitmap;
        }

        private static bool Different(Bitmap first, Bitmap second)
        {
            if (first.Size != second.Size) { return true; }
            for (int y = 0; y < first.Height; y++)
            {
                for (int x = 0; x < first.Width; x++)
                {
                    if (first.GetPixel(x, y) != second.GetPixel(x, y)) { return true; }
                }
            }
            return false;
        }

        private static void RequirePinned(Bitmap first, Bitmap second, Rectangle viewport)
        {
            Require(first.Size == second.Size, "Scrolling must retain the queue view's size");
            for (int y = 0; y < first.Height; y++)
            {
                if (y >= viewport.Top && y < viewport.Bottom) { continue; }
                for (int x = 0; x < first.Width; x++)
                {
                    Require(first.GetPixel(x, y) == second.GetPixel(x, y),
                        "Scrolling jobs must leave the queue header and resource footer pinned");
                }
            }
        }

        private static void FullQueue(string output)
        {
            using (var view = new QueueView())
            {
                var status = Status();
                view.UpdateStatus(status);
                Require(view.ListedJobs == 4 && view.WaitingJobs == 2,
                    "The queue view must list both running and waiting jobs");
                Require(!view.QueueIncomplete, "A complete waiting list must not be called incomplete");
                if (output != null)
                {
                    using (Bitmap bitmap = Paint(view))
                    {
                        bitmap.Save(output, System.Drawing.Imaging.ImageFormat.Png);
                        Console.WriteLine(output);
                    }
                }

                // A held queue can have waiting work without a running job. It must remain visible in the window.
                status["running"] = 0;
                status["jobs"] = new object[0];
                status["state"] = "paused";
                view.UpdateStatus(status);
                Require(view.Busy && view.ListedJobs == 2 && view.WaitingJobs == 2,
                    "Waiting work must remain available in the window while no job is running");

                // Missing or partial observations must not turn waiting work into an empty queue.
                status["queued"] = null;
                status["queuedJobs"] = null;
                view.UpdateStatus(status);
                Require(view.QueueIncomplete, "An unavailable waiting observation must remain unknown");
                status["queued"] = 2;
                status["queuedJobs"] = new object[]
                {
                    new Dictionary<string, object> { { "id", "known-waiter" }, { "name", "Известное задание" } },
                };
                view.UpdateStatus(status);
                Require(view.Busy && view.WaitingJobs == 1 && view.QueueIncomplete,
                    "A partial waiting list must retain its known job and its incomplete state");

                status["queued"] = null;
                view.UpdateStatus(status);
                Require(view.Busy && view.WaitingJobs == 1,
                    "Known waiting jobs must open the queue view even when queue totals are unavailable");

                var active = new List<object>();
                var waiting = new List<object>();
                for (int i = 0; i < 5; i++)
                {
                    active.Add(new Dictionary<string, object>
                    {
                        { "id", "active-" + i }, { "name", "Выполняется " + (i + 1) }, { "resource", "gpu" },
                        { "progress", new Dictionary<string, object> { { "percent", i * 17 + 3 }, { "scope", "job" } } },
                    });
                }
                for (int i = 0; i < 32; i++)
                {
                    waiting.Add(new Dictionary<string, object>
                    {
                        { "id", "waiting-" + i }, { "name", "Ожидает " + (i + 1) }, { "resource", i % 2 == 0 ? "gpu" : "cpu" },
                        { "private", i == 30 },
                    });
                }
                status["running"] = active.Count;
                status["jobs"] = active.ToArray();
                status["queued"] = waiting.Count;
                status["queuedJobs"] = waiting.ToArray();
                status["state"] = "working";
                view.UpdateStatus(status);
                Require(view.ListedJobs == 37 && view.WaitingJobs == 32,
                    "The queue view must retain every job beyond the former three-job limit");
                Require(view.MaximumScroll > 0 && view.ScrollOffset == 0,
                    "A long queue must have a bounded, initially unscrolled viewport");
                Require(new Rectangle(Point.Empty, view.ClientSize).Contains(view.ListBounds),
                    "The scrolling list must stay within the queue view");
                using (Bitmap first = Paint(view))
                {
                    view.ScrollBy(20);
                    using (Bitmap partial = Paint(view))
                    {
                        Require(Different(first, partial), "A partial row scroll must update the visible list");
                        RequirePinned(first, partial, view.ListBounds);
                    }
                    view.ScrollBy(-100000);
                    MethodInfo wheel = typeof(QueueView).GetMethod("OnMouseWheel", BindingFlags.Instance | BindingFlags.NonPublic);
                    Require(wheel != null, "The queue view must accept mouse-wheel scrolling");
                    for (int i = 0; i < 100 && view.ScrollOffset < view.MaximumScroll; i++)
                    {
                        wheel.Invoke(view, new object[] { new MouseEventArgs(MouseButtons.None, 0, 20, view.ListBounds.Top + 10, -120) });
                    }
                    Require(view.ScrollOffset == view.MaximumScroll,
                        "The mouse wheel must reach the last waiting job");
                    using (Bitmap last = Paint(view))
                    {
                        Require(Different(first, last), "Scrolling must paint a different part of the queue");
                        RequirePinned(first, last, view.ListBounds);
                        if (output != null)
                        {
                            string end = Path.Combine(Path.GetDirectoryName(output), Path.GetFileNameWithoutExtension(output) + "-end.png");
                            last.Save(end, System.Drawing.Imaging.ImageFormat.Png);
                            Console.WriteLine(end);
                        }
                    }
                }
                view.ScrollBy(-100000);
                Require(view.ScrollOffset == 0, "Scrolling above the first row must clamp to the start");
                view.ScrollBy(100000);
                Require(view.ScrollOffset == view.MaximumScroll, "Scrolling past the last row must clamp to the end");

                // Live updates may make the queue shorter while the user is looking at its final rows.
                status["running"] = 0;
                status["jobs"] = new object[0];
                status["queued"] = 1;
                status["queuedJobs"] = new object[] { waiting[0] };
                view.UpdateStatus(status);
                Require(view.Busy && view.ListedJobs == 1 && view.ScrollOffset == 0 && view.MaximumScroll == 0,
                    "A shrinking queue must clamp its old scroll position and keep the remaining job visible");
            }
        }

        private static QueueMenu Menu(Dictionary<string, object> status, bool held)
        {
            var menu = new QueueMenu { Status = status };
            menu.Items.Add(new QueueItem { Text = "Пауза", Post = "/api/queue/pause", Enabled = !held });
            menu.Items.Add(new QueueItem { Text = "Стоп", Post = "/api/queue/stop", Enabled = !held });
            menu.Items.Add(new QueueItem { Text = "Продолжить", Post = "/api/queue/continue", Enabled = held });
            return menu;
        }

        private static Dictionary<string, object> Idle()
        {
            return new Dictionary<string, object>
            {
                { "running", 0 }, { "jobs", new object[0] },
                { "queued", 0 }, { "queuedJobs", new object[0] },
                { "state", "ready" }, { "label", "Очередь пуста" },
            };
        }

        private static Button Button(ControlWindow window, string name)
        {
            Control[] controls = window.Controls.Find(name, true);
            Require(controls.Length == 1 && controls[0] is Button,
                "The control window is missing its " + name + " button");
            return (Button)controls[0];
        }

        private static QueueView Queue(Control parent)
        {
            foreach (Control child in parent.Controls)
            {
                QueueView view = child as QueueView;
                if (view != null) { return view; }
                view = Queue(child);
                if (view != null) { return view; }
            }
            return null;
        }

        private static bool HasText(Control parent, string text)
        {
            if (parent.Visible && parent.Text.Contains(text)) { return true; }
            foreach (Control child in parent.Controls)
            {
                if (HasText(child, text)) { return true; }
            }
            return false;
        }

        private static void PrepareWindow(ControlWindow window)
        {
            // Exercise the real form without presenting the fixture on the user's desktop.
            window.StartPosition = FormStartPosition.Manual;
            window.Location = new Point(-32000, -32000);
            window.ShowInTaskbar = false;
        }

        private static void RequireButtonsFit(ControlWindow window)
        {
            foreach (string name in new[] { "start", "restart", "stop", "web", "logs", "refresh", "queue-pause", "queue-stop", "queue-continue" })
            {
                Button button = Button(window, name);
                if (!button.Visible) { continue; }
                Rectangle bounds = button.RectangleToScreen(button.ClientRectangle);
                for (Control parent = button.Parent; parent != null; parent = parent.Parent)
                {
                    Require(parent.RectangleToScreen(parent.ClientRectangle).Contains(bounds),
                        "The " + name + " button must fit its row so its label and hit target are not clipped");
                }
            }
        }

        private static void Window(string output)
        {
            using (var window = new ControlWindow())
            {
                PrepareWindow(window);
                var parameters = (CreateParams)typeof(ControlWindow)
                    .GetProperty("CreateParams", BindingFlags.Instance | BindingFlags.NonPublic).GetValue(window, null);
                Require((parameters.ExStyle & 0x08000000) == 0 && !window.TopMost,
                    "The control window must be a normal activating window");
                Require(window.FormBorderStyle != FormBorderStyle.None,
                    "The control window needs a normal title bar and close button");
                int web = 0;
                window.OpenWebRequested += delegate { web++; };
                window.ApplyState(new Health(), new QueueMenu(), "Пульт недоступен", false, "");
                window.Open();
                Application.DoEvents();
                Require(window.Visible && !window.IsDisposed,
                    "The window must open even while the hub and inference are offline");
                QueueView queue = Queue(window);
                Require(queue != null && queue.Visible && !queue.Busy,
                    "An offline control window must include its available queue view");
                Require(Button(window, "start").Enabled && !Button(window, "restart").Enabled && !Button(window, "stop").Enabled,
                    "An offline hub should offer start without restart or stop");
                RequireButtonsFit(window);
                window.Close();
                Require(!window.Visible && !window.IsDisposed,
                    "Closing the control window must hide it without disposing the tray's view");

                window.ApplyState(new Health { Up = true }, Menu(Idle(), false), "Работает", false, "");
                window.Open();
                Application.DoEvents();
                Require(window.Visible && queue.Visible && !queue.Busy,
                    "The same window must reopen with an idle queue");
                window.ApplyState(new Health { Up = true }, Menu(Status(), false), "Работает", false, "");
                Require(window.Visible && queue.Busy && queue.ListedJobs == 4,
                    "The existing window must receive the full running and waiting queue");
                RequireButtonsFit(window);
                Size normal = window.Size;
                window.Size = window.MinimumSize;
                Application.DoEvents();
                RequireButtonsFit(window);
                Require(queue.ClientRectangle.Contains(queue.ListBounds),
                    "Resizing to the compact minimum must retain the queue inside its viewport");
                window.Size = normal;
                Application.DoEvents();
                if (output != null)
                {
                    using (var bitmap = new Bitmap(window.Width, window.Height))
                    {
                        window.DrawToBitmap(bitmap, new Rectangle(Point.Empty, bitmap.Size));
                        bitmap.Save(output, System.Drawing.Imaging.ImageFormat.Png);
                        Console.WriteLine(output);
                    }
                }
                Require(web == 0, "Opening or refreshing the control window must never open a browser");
                window.Close();
                window.Open();
                Require(window.Visible && ReferenceEquals(queue, Queue(window)),
                    "Reopening must retain the same embedded queue control");
                window.Close();
            }
        }

        private static void Actions()
        {
            using (var window = new ControlWindow())
            {
                PrepareWindow(window);
                int start = 0, restart = 0, stop = 0, web = 0, logs = 0, refresh = 0;
                var commands = new List<string>();
                window.StartRequested += delegate { start++; };
                window.RestartRequested += delegate { restart++; };
                window.StopRequested += delegate { stop++; };
                window.OpenWebRequested += delegate { web++; };
                window.LogsRequested += delegate { logs++; };
                window.RefreshRequested += delegate { refresh++; };
                // These callbacks record intent only: tests never alter the owner's real queue or services.
                window.QueueCommandRequested += delegate(string command) { commands.Add(command); };
                window.ApplyState(null, new QueueMenu(), "Проверяем", false, "");
                window.Open();
                Application.DoEvents();
                Require(!Button(window, "start").Enabled,
                    "An unobserved hub must not offer an unverified start action");
                window.ApplyState(new Health(), new QueueMenu(), "Недоступен", false, "");
                Button(window, "start").PerformClick();
                Button(window, "restart").PerformClick();
                Require(start == 1 && restart == 0,
                    "The offline start button must route only its own enabled action");

                QueueMenu menu = Menu(Status(), false);
                window.ApplyState(new Health { Up = true }, menu, "Работает", false, "");
                Button(window, "restart").PerformClick();
                Button(window, "stop").PerformClick();
                Button(window, "logs").PerformClick();
                Button(window, "refresh").PerformClick();
                Require(restart == 1 && stop == 1 && logs == 1 && refresh == 1 && web == 0,
                    "Local control actions must route independently without opening the web panel");
                Button(window, "web").PerformClick();
                Require(web == 1, "The explicit web button must route its browser action once");
                Button(window, "queue-pause").PerformClick();
                Button(window, "queue-continue").PerformClick();
                Require(commands.Count == 1 && commands[0] == "/api/queue/pause",
                    "Only an enabled explicit queue action may be forwarded");

                window.StopConfirmation = delegate { return false; };
                Button(window, "queue-stop").PerformClick();
                Require(commands.Count == 1, "Declining the owner's stop must not forward a command");
                window.StopConfirmation = delegate { return true; };
                Button(window, "queue-stop").PerformClick();
                Require(commands.Count == 2 && commands[1] == "/api/queue/stop",
                    "Confirmed explicit stop should reach the fake callback exactly once");

                window.ApplyState(new Health { Up = true }, menu, "Перезапускаем", true, "");
                foreach (string name in new[] { "start", "restart", "stop", "logs", "refresh", "queue-pause", "queue-stop", "queue-continue" })
                {
                    Require(!Button(window, name).Enabled, "A pending command must disable " + name);
                    Button(window, name).PerformClick();
                }
                Require(start == 1 && restart == 1 && stop == 1 && logs == 1 && refresh == 1 && commands.Count == 2,
                    "Repeated clicks while pending must not submit duplicate actions");

                window.ApplyState(new Health { Up = true }, Menu(Status(), true), "Работает", false, "Fixture operation failed");
                Require(HasText(window, "Fixture operation failed") && Button(window, "restart").Enabled,
                    "A failed operation must be shown and allow the user to try again");
                Require(!Button(window, "queue-pause").Enabled && Button(window, "queue-continue").Enabled,
                    "A held queue must retain the observed menu's allowed controls");
                Button(window, "queue-pause").PerformClick();
                Button(window, "queue-continue").PerformClick();
                Require(commands.Count == 3 && commands[2] == "/api/queue/continue",
                    "Only the explicit enabled continue button may forward the owner's continuation");

                window.ApplyState(new Health(), menu, "Недоступен", false, "");
                Require(!Button(window, "queue-pause").Enabled && !Button(window, "queue-stop").Enabled && !Button(window, "queue-continue").Enabled,
                    "A lost hub connection must not leave stale queue controls enabled");
                Require(!HasText(window, "Fixture operation failed"),
                    "A fresh error-free observation must clear the operation error");
                window.Close();
            }
        }

        private static void Projects()
        {
            using (var window = new ControlWindow())
            {
                PrepareWindow(window);
                var opened = new List<string>();
                var commands = new List<string>();
                window.ProjectOpenRequested += delegate(string url) { opened.Add(url); };
                window.ProjectCommandRequested += delegate(string id, string action, bool takeover)
                {
                    commands.Add(id + ":" + action + ":" + takeover);
                };
                window.ProjectConfirmation = delegate { return false; };
                ProjectList list = ProjectList.Parse(
                    "{\"projects\":["
                    + "{\"id\":\"sample\",\"name\":\"Sample\",\"summary\":\"web:5000\",\"open\":\"http://127.0.0.1:5000/\",\"restart\":true,\"foreign\":false,\"tone\":\"running\"},"
                    + "{\"id\":\"other\",\"name\":\"Other\",\"summary\":\"api\",\"open\":\"http://127.0.0.1:8100/\",\"restart\":true,\"foreign\":true,\"tone\":\"external\"}"
                    + "]}");
                window.ApplyState(new Health { Up = true }, new QueueMenu(), "Работает", false, "", list);
                window.Open();
                Application.DoEvents();
                Require(HasText(window, "Sample") && HasText(window, "2 запущено"),
                    "Running projects must be listed as compact cards");
                Button(window, "project-open-sample").PerformClick();
                Button(window, "project-restart-sample").PerformClick();
                Button(window, "project-stop-sample").PerformClick();
                Require(opened.Count == 1 && opened[0] == "http://127.0.0.1:5000/",
                    "Open must use the project's own page");
                Require(commands.Count == 2 && commands[0] == "sample:restart:False" && commands[1] == "sample:stop:False",
                    "A hub-owned project restarts and stops without a takeover");
                Button(window, "project-stop-other").PerformClick();
                Require(commands.Count == 2, "Declining a foreign stop must not send it");
                window.ProjectConfirmation = delegate { return true; };
                Button(window, "project-restart-other").PerformClick();
                Require(commands.Count == 3 && commands[2] == "other:restart:True",
                    "A confirmed foreign restart must ask the hub to take the process over");
                window.ApplyState(new Health { Up = true }, new QueueMenu(), "Работает", true, "", list);
                Application.DoEvents();
                Require(!Button(window, "project-stop-sample").Enabled && !Button(window, "project-restart-sample").Enabled
                    && Button(window, "project-open-sample").Enabled,
                    "A pending command must leave open available and block stop and restart");
                Button(window, "project-stop-sample").PerformClick();
                Require(commands.Count == 3, "A pending stop must not be sent twice");
                window.Size = window.MinimumSize;
                Application.DoEvents();
                RequireButtonsFit(window);
                window.Close();
            }
        }

        private static void Heartbeat(string prefix)
        {
            File.WriteAllText(prefix + ".pid", Process.GetCurrentProcess().Id.ToString());
            var time = Stopwatch.StartNew();
            int tick = 0;
            // A failed test or a killed runner cannot leave this fixture process running indefinitely.
            while (time.ElapsedMilliseconds < 20000)
            {
                File.WriteAllText(prefix + ".beat", (++tick).ToString());
                Thread.Sleep(40);
            }
        }

        private static bool Alive(int pid)
        {
            try
            {
                using (var process = Process.GetProcessById(pid))
                {
                    return !process.HasExited;
                }
            }
            catch (ArgumentException)
            {
                return false;
            }
        }

        private static int Number(string file)
        {
            try
            {
                int number;
                // Observing the heartbeat must never deny its writer access. A read may still catch
                // an empty file between truncation and writing; callers wait for a complete tick.
                using (var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                using (var reader = new StreamReader(stream))
                {
                    return int.TryParse(reader.ReadToEnd(), out number) ? number : 0;
                }
            }
            catch (IOException)
            {
                return 0;
            }
        }

        private static void End(Process process)
        {
            if (process == null)
            {
                return;
            }
            try
            {
                if (!process.HasExited)
                {
                    process.Kill();
                }
                process.WaitForExit(5000);
            }
            catch (InvalidOperationException)
            {
                // Hub.Stop already disposed its launcher handle.
            }
            finally
            {
                process.Dispose();
            }
        }

        private static void Lifecycle(string root, string bun)
        {
            CheckLifecycle(root, bun, false);
            CheckLifecycle(root, bun, true);
        }

        private static void CheckLifecycle(string root, string bun, bool healthy)
        {
            string prefix = Path.Combine(root, "child-" + Guid.NewGuid().ToString("N"));
            string executable = Assembly.GetExecutingAssembly().Location;
            string script = prefix + ".js";
            File.WriteAllText(script,
                "import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs'; "
                + "writeFileSync(process.argv[3]+'.hub',String(process.pid)); "
                + "spawn(process.argv[2],['heartbeat',process.argv[3]],{stdio:'ignore',windowsHide:true,detached:true}).unref(); "
                + "await Bun.sleep(20000);");
            var info = new ProcessStartInfo(
                "cmd.exe", "/d /s /c \"\"" + bun + "\" \"" + script + "\" \"" + executable + "\" \"" + prefix + "\"\"");
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.WorkingDirectory = root;
            Process launcher = Process.Start(info);
            int launcherPid = launcher.Id;
            Process child = null;
            Process server = null;
            try
            {
                var deadline = Stopwatch.StartNew();
                while (Number(prefix + ".beat") == 0 && deadline.ElapsedMilliseconds < 5000)
                {
                    Thread.Sleep(20);
                }
                int childPid = Number(prefix + ".pid");
                int hubPid = Number(prefix + ".hub");
                Require(childPid > 0 && Alive(childPid), "Fixture heartbeat did not start");
                Require(hubPid > 0 && Alive(hubPid), "Fixture hub did not start");
                child = Process.GetProcessById(childPid);
                server = Process.GetProcessById(hubPid);
                int before = Number(prefix + ".beat");
                while (before == 0 && deadline.ElapsedMilliseconds < 5000)
                {
                    Thread.Sleep(20);
                    before = Number(prefix + ".beat");
                }
                Require(before > 0, "The heartbeat needs a complete baseline before stopping the hub");
                var hub = new Hub(root);
                typeof(Hub).GetField("started", BindingFlags.NonPublic | BindingFlags.Instance).SetValue(hub, launcher);
                typeof(Hub).GetField("startedBun", BindingFlags.NonPublic | BindingFlags.Instance).SetValue(hub, bun);
                // The direct Bun hub must stop even when its HTTP endpoint cannot answer. The independent
                // service below it must retain the same PID and continue its current work.
                hub.Stop(new Health { Up = healthy, Pid = healthy ? hubPid : 0 });
                Thread.Sleep(240);
                Require(!Alive(launcherPid), "The hub launcher should have stopped");
                Require(!Alive(hubPid), "The Bun hub must stop even when health does not answer");
                Require(Alive(childPid), "Restarting the hub killed its independent running service");
                var progressWait = Stopwatch.StartNew();
                int after = Number(prefix + ".beat");
                while (after <= before && Alive(childPid) && progressWait.ElapsedMilliseconds < 3000)
                {
                    Thread.Sleep(20);
                    after = Number(prefix + ".beat");
                }
                Require(Alive(childPid), "The independent service exited while observing its progress");
                Require(after > before, "The existing child must keep making progress after hub stop (before " + before + ", after " + after + ")");
                // A second stop has no owned process left and must remain harmless.
                hub.Stop(new Health());
                Require(Alive(childPid), "A repeated hub stop affected the independent service");
            }
            finally
            {
                End(child);
                End(server);
                End(launcher);
            }
        }
    }
}
