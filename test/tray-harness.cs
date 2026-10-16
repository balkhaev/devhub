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
                    case "popup": Popup(args.Length > 2 ? args[2] : null); break;
                    case "full-queue": FullQueue(args.Length > 2 ? args[2] : null); break;
                    case "placement": Placement(); break;
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
        }

        private static void Popup(string output)
        {
            using (var popup = new QueuePopup())
            {
                var parameters = (CreateParams)typeof(QueuePopup)
                    .GetProperty("CreateParams", BindingFlags.Instance | BindingFlags.NonPublic).GetValue(popup, null);
                Require((parameters.ExStyle & 0x08000000) != 0 && (parameters.ExStyle & 0x00000080) != 0,
                    "The popup must remain a non-activating tool window");
                Require(popup.TopMost && !popup.ShowInTaskbar,
                    "The popup must stay above shell windows without adding a taskbar entry");
                Dictionary<string, object> status = Status();
                popup.UpdateStatus(status);
                Require(popup.Busy, "Active inference must be visible on hover");
                var jobs = (IList)status["jobs"];
                var progress = (Dictionary<string, object>)((Dictionary<string, object>)jobs[0])["progress"];
                string words = QueuePopup.ProgressWords(progress);
                Require(words.Contains((37.5).ToString("0.#") + "% операции") && words.Contains("шаг 3 из 8"),
                    "The hover popup must show the measured percentage, its scope and its steps");
                Require(QueuePopup.ProgressWords(null) == "Ожидаем данные о прогрессе",
                    "Unknown progress must remain unknown");
                using (var bitmap = new Bitmap(popup.Width, popup.Height))
                {
                    popup.DrawToBitmap(bitmap, new Rectangle(Point.Empty, bitmap.Size));
                    bool filled = false;
                    for (int y = 0; y < bitmap.Height && !filled; y++)
                    {
                        for (int x = 0; x < bitmap.Width && !filled; x++)
                        {
                            filled = bitmap.GetPixel(x, y).ToArgb() == Color.FromArgb(89, 202, 170).ToArgb();
                        }
                    }
                    Require(filled, "The native popup did not paint the measured progress bar");
                    if (output != null)
                    {
                        bitmap.Save(output, System.Drawing.Imaging.ImageFormat.Png);
                        Console.WriteLine(output);
                    }
                }
                popup.UpdateStatus(new Dictionary<string, object>
                {
                    { "running", 0 },
                    { "jobs", new object[0] },
                    { "queued", 0 },
                });
                Require(!popup.Busy, "An idle queue must dismiss its progress popup");
                popup.UpdateStatus(null);
                Require(!popup.Busy, "A missing observation must not leave stale work visible");
            }
        }

        private static Bitmap Paint(QueuePopup popup)
        {
            var bitmap = new Bitmap(popup.Width, popup.Height);
            popup.DrawToBitmap(bitmap, new Rectangle(Point.Empty, bitmap.Size));
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
            Require(first.Size == second.Size, "Scrolling must retain the popup's size");
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
            using (var popup = new QueuePopup())
            {
                var status = Status();
                popup.UpdateStatus(status);
                Require(popup.ListedJobs == 4 && popup.WaitingJobs == 2,
                    "The hover popup must list both running and waiting jobs");
                Require(!popup.QueueIncomplete, "A complete waiting list must not be called incomplete");
                if (output != null)
                {
                    using (Bitmap bitmap = Paint(popup))
                    {
                        bitmap.Save(output, System.Drawing.Imaging.ImageFormat.Png);
                        Console.WriteLine(output);
                    }
                }

                // A held queue can have waiting work without a running job. It must still open on hover.
                status["running"] = 0;
                status["jobs"] = new object[0];
                status["state"] = "paused";
                popup.UpdateStatus(status);
                Require(popup.Busy && popup.ListedJobs == 2 && popup.WaitingJobs == 2,
                    "Waiting work must remain available on hover while no job is running");

                // Missing or partial observations must not turn waiting work into an empty queue.
                status["queued"] = null;
                status["queuedJobs"] = null;
                popup.UpdateStatus(status);
                Require(popup.QueueIncomplete, "An unavailable waiting observation must remain unknown");
                status["queued"] = 2;
                status["queuedJobs"] = new object[]
                {
                    new Dictionary<string, object> { { "id", "known-waiter" }, { "name", "Известное задание" } },
                };
                popup.UpdateStatus(status);
                Require(popup.Busy && popup.WaitingJobs == 1 && popup.QueueIncomplete,
                    "A partial waiting list must retain its known job and its incomplete state");

                status["queued"] = null;
                popup.UpdateStatus(status);
                Require(popup.Busy && popup.WaitingJobs == 1,
                    "Known waiting jobs must open the popup even when queue totals are unavailable");

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
                popup.UpdateStatus(status);
                Require(popup.ListedJobs == 37 && popup.WaitingJobs == 32,
                    "The popup must retain every job beyond the former three-job limit");
                Require(popup.MaximumScroll > 0 && popup.ScrollOffset == 0,
                    "A long queue must have a bounded, initially unscrolled viewport");
                Require(new Rectangle(Point.Empty, popup.ClientSize).Contains(popup.ListBounds),
                    "The scrolling list must stay within the popup");
                using (Bitmap first = Paint(popup))
                {
                    popup.ScrollBy(20);
                    using (Bitmap partial = Paint(popup))
                    {
                        Require(Different(first, partial), "A partial row scroll must update the visible list");
                        RequirePinned(first, partial, popup.ListBounds);
                    }
                    popup.ScrollBy(-100000);
                    MethodInfo wheel = typeof(QueuePopup).GetMethod("OnMouseWheel", BindingFlags.Instance | BindingFlags.NonPublic);
                    Require(wheel != null, "The popup must accept mouse-wheel scrolling");
                    for (int i = 0; i < 100 && popup.ScrollOffset < popup.MaximumScroll; i++)
                    {
                        wheel.Invoke(popup, new object[] { new MouseEventArgs(MouseButtons.None, 0, 20, popup.ListBounds.Top + 10, -120) });
                    }
                    Require(popup.ScrollOffset == popup.MaximumScroll,
                        "The mouse wheel must reach the last waiting job");
                    using (Bitmap last = Paint(popup))
                    {
                        Require(Different(first, last), "Scrolling must paint a different part of the queue");
                        RequirePinned(first, last, popup.ListBounds);
                        if (output != null)
                        {
                            string end = Path.Combine(Path.GetDirectoryName(output), Path.GetFileNameWithoutExtension(output) + "-end.png");
                            last.Save(end, System.Drawing.Imaging.ImageFormat.Png);
                            Console.WriteLine(end);
                        }
                    }
                }
                popup.ScrollBy(-100000);
                Require(popup.ScrollOffset == 0, "Scrolling above the first row must clamp to the start");
                popup.ScrollBy(100000);
                Require(popup.ScrollOffset == popup.MaximumScroll, "Scrolling past the last row must clamp to the end");

                // Live updates may make the queue shorter while the user is looking at its final rows.
                status["running"] = 0;
                status["jobs"] = new object[0];
                status["queued"] = 1;
                status["queuedJobs"] = new object[] { waiting[0] };
                popup.UpdateStatus(status);
                Require(popup.Busy && popup.ListedJobs == 1 && popup.ScrollOffset == 0 && popup.MaximumScroll == 0,
                    "A shrinking queue must clamp its old scroll position and keep the remaining job visible");
            }
        }

        private static void CheckPlacement(Rectangle work, Rectangle tray, Point anchor, Size size, bool fullSize)
        {
            Rectangle placed = TrayWindows.Position(work, tray, anchor, size, 8);
            Require(placed.Width > 0 && placed.Height > 0 && work.Contains(placed),
                "The hover card must remain inside its monitor's working area");
            Require(!placed.IntersectsWith(tray), "The hover card must not hide behind the notification flyout");
            if (fullSize) { Require(placed.Size == size, "The card should retain its size when there is room beside the tray"); }
        }

        private static void Placement()
        {
            var work = new Rectangle(0, 0, 1920, 1040);
            var card = new Size(360, 400);
            CheckPlacement(work, new Rectangle(1620, 710, 300, 320), new Point(1770, 1000), card, true);
            CheckPlacement(work, new Rectangle(1620, 0, 300, 320), new Point(1770, 20), card, true);
            CheckPlacement(work, new Rectangle(0, 340, 300, 500), new Point(20, 700), card, true);
            CheckPlacement(work, new Rectangle(1620, 340, 300, 500), new Point(1900, 700), card, true);
            CheckPlacement(work, new Rectangle(1620, 200, 300, 840), new Point(1770, 1000), new Size(360, 900), true);
            CheckPlacement(new Rectangle(-1920, -200, 1920, 1040), new Rectangle(-300, 510, 300, 320),
                new Point(-150, 800), card, true);
            CheckPlacement(new Rectangle(1920, 200, 1280, 900), new Rectangle(2900, 780, 300, 320),
                new Point(3100, 1060), card, true);
            CheckPlacement(new Rectangle(0, 0, 600, 500), new Rectangle(200, 120, 400, 380),
                new Point(560, 460), card, false);
            CheckPlacement(new Rectangle(0, 0, 120, 90), new Rectangle(20, 60, 100, 30),
                new Point(100, 75), card, false);
            CheckPlacement(work, Rectangle.Empty, new Point(1900, 1030), card, true);
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
