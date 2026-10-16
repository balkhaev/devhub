using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Threading;
using System.Web.Script.Serialization;

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
                + "\"queued\":2,\"label\":\"Выполняется: 2\",\"state\":\"working\","
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
                return int.TryParse(File.ReadAllText(file), out number) ? number : 0;
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
                Require(Number(prefix + ".beat") > before, "The existing child must keep making progress after hub stop");
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
