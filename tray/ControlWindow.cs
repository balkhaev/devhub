using System;
using System.Collections.Generic;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace Devhub
{
    /// <summary>The tray's small, persistent control surface. All service actions belong to TrayApp.</summary>
    internal sealed class ControlWindow : Form
    {
        private static readonly Color Surface = Color.FromArgb(24, 27, 33);
        private static readonly Color Raised = Color.FromArgb(36, 41, 50);
        private static readonly Color TextColor = Color.FromArgb(235, 240, 247);
        private static readonly Color Muted = Color.FromArgb(154, 165, 181);
        private static readonly Color Accent = Color.FromArgb(89, 202, 170);
        private static readonly Color Warning = Color.FromArgb(238, 184, 107);
        private readonly QueueView queueView;
        private readonly Panel projectsHost;
        private readonly Label projectsState;
        private readonly Label hubStatus;
        private readonly Label queueState;
        private readonly Label errorLabel;
        private readonly Label footnote;
        private readonly TableLayoutPanel layout;
        private readonly Button start;
        private readonly Button restart;
        private readonly Button stopHub;
        private readonly Button web;
        private readonly Button logs;
        private readonly Button refresh;
        private readonly Button pause;
        private readonly Button stop;
        private readonly Button resume;
        private readonly ToolTip hints;
        private readonly Font titleFont;
        private readonly Font smallFont;
        private readonly int errorRow = 10;
        private string projectsKey = "";
        private bool disposing;

        private sealed class ControlButton : Button
        {
            protected override void OnPaint(PaintEventArgs args)
            {
                if (Enabled)
                {
                    base.OnPaint(args);
                    return;
                }
                args.Graphics.Clear(Color.FromArgb(29, 33, 40));
                ControlPaint.DrawBorder(args.Graphics, ClientRectangle,
                    Color.FromArgb(48, 55, 66), ButtonBorderStyle.Solid);
                Rectangle textBounds = ClientRectangle;
                textBounds.Inflate(-4, -1);
                TextRenderer.DrawText(args.Graphics, Text, Font, textBounds, Muted,
                    TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter
                    | TextFormatFlags.SingleLine | TextFormatFlags.NoPrefix | TextFormatFlags.EndEllipsis);
            }
        }

        public event Action StartRequested;
        public event Action RestartRequested;
        public event Action StopRequested;
        public event Action OpenWebRequested;
        public event Action LogsRequested;
        public event Action RefreshRequested;
        public event Action<string> QueueCommandRequested;
        /// <summary>An absolute local page: the project's app, or its page in the hub.</summary>
        public event Action<string> ProjectOpenRequested;
        /// <summary>Project id, stop or restart, and whether the person agreed to take over a foreign process.</summary>
        public event Action<string, string, bool> ProjectCommandRequested;

        /// <summary>Only a person clicking the confirmation may stop the owner's queue.</summary>
        internal Func<bool> StopConfirmation { get; set; }

        /// <summary>Asked only when a running project was not started from the hub. Tests replace the dialog.</summary>
        internal Func<string, string, bool> ProjectConfirmation { get; set; }

        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);

        public ControlWindow()
        {
            Text = "Пульт · проекты и Inference";
            Name = "control-window";
            FormBorderStyle = FormBorderStyle.Sizable;
            ShowInTaskbar = true;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(460, 790);
            MinimumSize = new Size(440, 740);
            BackColor = Surface;
            ForeColor = TextColor;
            Font = new Font("Segoe UI", 9F);
            AutoScaleDimensions = new SizeF(96F, 96F);
            AutoScaleMode = AutoScaleMode.Dpi;
            DoubleBuffered = true;
            MaximizeBox = false;
            titleFont = new Font("Segoe UI", 12F, FontStyle.Bold);
            smallFont = new Font("Segoe UI", 8F);
            hints = new ToolTip();

            layout = new TableLayoutPanel();
            layout.Dock = DockStyle.Fill;
            layout.Padding = new Padding(16, 12, 16, 10);
            layout.BackColor = Surface;
            layout.ColumnCount = 1;
            layout.RowCount = 12;
            layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 34));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 27));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 34));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 14));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 30));
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 14));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 46));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 176));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 45));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 0));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 31));
            Controls.Add(layout);

            var hubHeading = new TableLayoutPanel();
            hubHeading.Dock = DockStyle.Fill;
            hubHeading.Margin = Padding.Empty;
            hubHeading.ColumnCount = 2;
            hubHeading.RowCount = 1;
            hubHeading.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            hubHeading.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 115));
            hubHeading.Controls.Add(Label("DevHub", titleFont, TextColor), 0, 0);
            web = Button("web", "Веб-панель ↗", delegate { Raise(OpenWebRequested); });
            hubHeading.Controls.Add(web, 1, 0);
            layout.Controls.Add(hubHeading, 0, 0);

            hubStatus = Label("Проверяю пульт…", Font, Muted);
            layout.Controls.Add(hubStatus, 0, 1);
            start = Button("start", "Запустить", delegate { Raise(StartRequested); });
            restart = Button("restart", "Перезапустить", delegate { Raise(RestartRequested); });
            stopHub = Button("stop", "Остановить", delegate { Raise(StopRequested); });
            logs = Button("logs", "Логи", delegate { Raise(LogsRequested); });
            var hubPrimary = new Panel { Dock = DockStyle.Fill, Margin = Padding.Empty };
            hubPrimary.Controls.Add(start);
            hubPrimary.Controls.Add(restart);
            layout.Controls.Add(ButtonRow(hubPrimary, stopHub, logs), 0, 2);
            hints.SetToolTip(restart, "Перезапустить только DevHub. Inference и задания продолжат работу.");
            hints.SetToolTip(stopHub, "Выключить только DevHub. Inference и серверы проектов продолжат работу.");
            hints.SetToolTip(logs, "Открыть папку с логами DevHub");

            var divider = new Panel();
            divider.BackColor = Color.FromArgb(48, 55, 66);
            divider.Dock = DockStyle.Fill;
            divider.Margin = new Padding(0, 6, 0, 6);
            layout.Controls.Add(divider, 0, 3);

            var projectsHeading = new TableLayoutPanel();
            projectsHeading.Dock = DockStyle.Fill;
            projectsHeading.Margin = Padding.Empty;
            projectsHeading.ColumnCount = 2;
            projectsHeading.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            projectsHeading.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 150));
            projectsHeading.Controls.Add(Label("Проекты", titleFont, TextColor), 0, 0);
            projectsState = Label("Проверяю проекты…", smallFont, Muted);
            projectsState.Name = "projects-state";
            projectsState.TextAlign = ContentAlignment.MiddleRight;
            projectsHeading.Controls.Add(projectsState, 1, 0);
            layout.Controls.Add(projectsHeading, 0, 4);

            projectsHost = new Panel();
            projectsHost.Name = "projects-view";
            projectsHost.Dock = DockStyle.Fill;
            projectsHost.Margin = Padding.Empty;
            projectsHost.AutoScroll = true;
            projectsHost.BackColor = Surface;
            projectsHost.Resize += delegate { PlaceCards(); };
            layout.Controls.Add(projectsHost, 0, 5);

            var divider2 = new Panel();
            divider2.BackColor = Color.FromArgb(48, 55, 66);
            divider2.Dock = DockStyle.Fill;
            divider2.Margin = new Padding(0, 6, 0, 6);
            layout.Controls.Add(divider2, 0, 6);

            var inferenceHeading = new TableLayoutPanel();
            inferenceHeading.Dock = DockStyle.Fill;
            inferenceHeading.Margin = Padding.Empty;
            inferenceHeading.ColumnCount = 1;
            inferenceHeading.RowCount = 2;
            inferenceHeading.RowStyles.Add(new RowStyle(SizeType.Absolute, 25));
            inferenceHeading.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            inferenceHeading.Controls.Add(Label("Inference", titleFont, TextColor), 0, 0);
            queueState = Label("Проверяю очередь…", smallFont, Muted);
            inferenceHeading.Controls.Add(queueState, 0, 1);
            layout.Controls.Add(inferenceHeading, 0, 7);

            queueView = new QueueView();
            queueView.Name = "queue-view";
            queueView.Dock = DockStyle.Fill;
            queueView.Margin = Padding.Empty;
            layout.Controls.Add(queueView, 0, 8);

            pause = Button("queue-pause", "Пауза", delegate { QueueAction("/api/queue/pause"); });
            stop = Button("queue-stop", "Стоп очереди", delegate
            {
                if (StopConfirmation != null && StopConfirmation()) { QueueAction("/api/queue/stop"); }
            });
            resume = Button("queue-continue", "Продолжить", delegate { QueueAction("/api/queue/continue"); });
            var queueActions = ButtonRow(pause, stop, resume);
            queueActions.Padding = new Padding(0, 10, 0, 0);
            layout.Controls.Add(queueActions, 0, 9);
            hints.SetToolTip(pause, "Временно не начинать новые задания. Текущие продолжат работу.");
            hints.SetToolTip(stop, "Остановить начало новых заданий до вашей команды «Продолжить».");
            hints.SetToolTip(resume, "Продолжить общую очередь после стопа или паузы.");

            errorLabel = Label("", smallFont, Color.FromArgb(244, 150, 150));
            errorLabel.Name = "action-error";
            errorLabel.Padding = new Padding(0, 4, 0, 0);
            errorLabel.AutoEllipsis = true;
            layout.Controls.Add(errorLabel, 0, errorRow);

            var footer = new TableLayoutPanel();
            footer.Dock = DockStyle.Fill;
            footer.Margin = Padding.Empty;
            footer.Padding = new Padding(0, 6, 0, 0);
            footer.ColumnCount = 2;
            footer.RowCount = 1;
            footer.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            footer.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 95));
            footnote = Label("Обновляется автоматически", smallFont, Muted);
            footer.Controls.Add(footnote, 0, 0);
            refresh = Button("refresh", "Обновить", delegate { Raise(RefreshRequested); });
            refresh.Font = smallFont;
            footer.Controls.Add(refresh, 1, 0);
            layout.Controls.Add(footer, 0, 11);

            StopConfirmation = delegate
            {
                return MessageBox.Show(this,
                    "Новые задания не будут запускаться, пока вы не нажмёте «Продолжить». "
                    + "Выполняющиеся задания продолжат работу.\n\nОстановить общую очередь?",
                    "Стоп общей очереди", MessageBoxButtons.YesNo, MessageBoxIcon.Question,
                    MessageBoxDefaultButton.Button2) == DialogResult.Yes;
            };
            ProjectConfirmation = delegate(string name, string action)
            {
                string text = action == "restart"
                    ? name + " запущен не из пульта.\n\nПульт остановит его и запустит заново сам. Продолжить?"
                    : name + " запущен не из пульта.\n\nОстановить его и всё, что он запустил?";
                return MessageBox.Show(this, text, "Проект " + name,
                    MessageBoxButtons.YesNo, MessageBoxIcon.Question,
                    MessageBoxDefaultButton.Button2) == DialogResult.Yes;
            };
            ApplyState(null, null, null, false, null);
        }

        private static Label Label(string text, Font font, Color color)
        {
            return new Label
            {
                Text = text,
                Font = font,
                ForeColor = color,
                Dock = DockStyle.Fill,
                Margin = Padding.Empty,
                TextAlign = ContentAlignment.MiddleLeft,
                AutoEllipsis = true,
                UseMnemonic = false,
            };
        }

        private Button Button(string name, string text, Action action)
        {
            var button = new ControlButton();
            button.Name = name;
            button.Text = text;
            button.Dock = DockStyle.Fill;
            button.Margin = Padding.Empty;
            button.FlatStyle = FlatStyle.Flat;
            button.FlatAppearance.BorderSize = 1;
            button.FlatAppearance.BorderColor = Color.FromArgb(59, 68, 81);
            button.FlatAppearance.MouseOverBackColor = Color.FromArgb(47, 55, 66);
            button.FlatAppearance.MouseDownBackColor = Color.FromArgb(55, 66, 79);
            button.BackColor = Raised;
            button.ForeColor = TextColor;
            button.UseVisualStyleBackColor = false;
            button.UseMnemonic = false;
            button.Cursor = Cursors.Hand;
            button.Click += delegate { if (button.Enabled) { action(); } };
            return button;
        }

        private static TableLayoutPanel ButtonRow(params Control[] buttons)
        {
            var row = new TableLayoutPanel();
            row.Dock = DockStyle.Fill;
            row.Margin = Padding.Empty;
            row.RowCount = 1;
            row.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            row.ColumnCount = buttons.Length * 2 - 1;
            for (int index = 0; index < buttons.Length; index++)
            {
                row.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F / buttons.Length));
                row.Controls.Add(buttons[index], index * 2, 0);
                if (index + 1 < buttons.Length) { row.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 7)); }
            }
            return row;
        }

        private static void Raise(Action action)
        {
            if (action != null) { action(); }
        }

        private void QueueAction(string path)
        {
            var action = QueueCommandRequested;
            if (action != null) { action(path); }
        }

        private static bool Can(QueueMenu menu, string path)
        {
            if (menu == null) { return false; }
            foreach (QueueItem item in menu.Items)
            {
                if (item.Post == path) { return item.Enabled; }
            }
            return false;
        }

        private static string QueueState(QueueMenu queue)
        {
            object value;
            return queue != null && queue.Status != null && queue.Status.TryGetValue("state", out value)
                ? value as string ?? "" : "";
        }

        public void ApplyState(Health health, QueueMenu queue, string hubText, bool pending, string error, ProjectList projects = null)
        {
            bool up = health != null && health.Up;
            hubStatus.Text = !string.IsNullOrEmpty(hubText) ? hubText : health == null ? "Проверяю пульт…"
                : up ? "● Пульт работает · сервисов: " + health.Managed : "● Пульт выключен";
            hubStatus.ForeColor = up ? Accent : health == null ? Muted : Warning;
            start.Visible = !up;
            start.Enabled = !pending && health != null && !up;
            restart.Visible = up;
            restart.Enabled = !pending && up;
            stopHub.Enabled = !pending && up;
            web.Enabled = !pending && up;
            logs.Enabled = !pending;
            refresh.Enabled = !pending;
            pause.Enabled = !pending && up && Can(queue, "/api/queue/pause");
            stop.Enabled = !pending && up && Can(queue, "/api/queue/stop");
            resume.Enabled = !pending && up && Can(queue, "/api/queue/continue");
            queueView.UpdateStatus(up && queue != null ? queue.Status : null);
            ShowProjects(health == null, up, pending, projects);

            string state = QueueState(queue);
            queueState.Text = !up ? "Нет связи с пультом" : state == "stopped" ? "Стоп владельца · новые задания ожидают"
                : state == "paused" ? "Пауза · новые задания ожидают"
                : state == "working" ? "Выполняет задания" : state == "ready" ? "Готов к заданиям"
                : state == "offline" ? "Нет связи с Inference" : "Данные очереди недоступны";
            queueState.ForeColor = !up ? Muted : state == "stopped" || state == "paused" ? Warning
                : state == "working" || state == "ready" ? Accent : Muted;
            string message = error ?? "";
            errorLabel.Text = message;
            hints.SetToolTip(errorLabel, message);
            layout.RowStyles[errorRow].Height = message.Length > 0 ? 38 : 0;
            footnote.Text = pending ? "Выполняю команду…" : "Обновляется автоматически";
        }

        private void ShowProjects(bool unknown, bool up, bool pending, ProjectList projects)
        {
            if (unknown)
            {
                projectsState.Text = "Проверяю проекты…";
                projectsState.ForeColor = Muted;
                ClearProjects();
                return;
            }
            if (!up)
            {
                projectsState.Text = "Нет связи с пультом";
                projectsState.ForeColor = Muted;
                ClearProjects();
                return;
            }
            if (projects != null && !projects.Online)
            {
                projectsState.Text = "Список недоступен";
                projectsState.ForeColor = Warning;
                ClearProjects();
                return;
            }
            List<ProjectCard> cards = projects == null ? new List<ProjectCard>() : projects.Projects;
            if (cards.Count == 0)
            {
                projectsState.Text = "Ничего не запущено";
                projectsState.ForeColor = Muted;
                ClearProjects();
                return;
            }
            projectsState.Text = cards.Count + " запущено";
            projectsState.ForeColor = Accent;
            string key = projects.Json ?? "";
            if (key != projectsKey || projectsHost.Controls.Count != cards.Count)
            {
                Rebuild(cards);
                projectsKey = key;
            }
            EnableProjectButtons(pending);
        }

        private void ClearProjects()
        {
            projectsKey = "";
            while (projectsHost.Controls.Count > 0)
            {
                Control child = projectsHost.Controls[0];
                projectsHost.Controls.Remove(child);
                child.Dispose();
            }
        }

        private void Rebuild(List<ProjectCard> cards)
        {
            int scroll = -projectsHost.AutoScrollPosition.Y;
            projectsHost.SuspendLayout();
            while (projectsHost.Controls.Count > 0)
            {
                Control child = projectsHost.Controls[0];
                projectsHost.Controls.Remove(child);
                child.Dispose();
            }
            foreach (ProjectCard card in cards)
            {
                projectsHost.Controls.Add(MakeCard(card));
            }
            projectsHost.ResumeLayout();
            PlaceCards();
            projectsHost.AutoScrollPosition = new Point(0, scroll);
        }

        private void PlaceCards()
        {
            if (projectsHost == null)
            {
                return;
            }
            int width = projectsHost.ClientSize.Width;
            if (projectsHost.VerticalScroll.Visible)
            {
                width -= SystemInformation.VerticalScrollBarWidth;
            }
            if (width < 120)
            {
                width = Math.Max(120, projectsHost.Width - 8);
            }
            int y = 0;
            foreach (Control card in projectsHost.Controls)
            {
                card.SetBounds(0, y, Math.Max(120, width - 2), 62);
                Control[] parts = card.Tag as Control[];
                if (parts != null && parts.Length == 3)
                {
                    parts[0].Width = card.Width - 30;
                    parts[1].Width = card.Width - 30;
                    parts[2].SetBounds(8, 38, card.Width - 16, 22);
                }
                y += 66;
            }
            projectsHost.AutoScrollMinSize = new Size(0, y);
        }

        private Control MakeCard(ProjectCard card)
        {
            var box = new Panel();
            box.Name = "project-card-" + card.Id;
            box.Height = 62;
            box.BackColor = Raised;
            var dot = new Panel();
            dot.Size = new Size(8, 8);
            dot.Location = new Point(8, 10);
            dot.BackColor = ToneColor(card.Tone);
            box.Controls.Add(dot);
            Label name = Label(card.Name, Font, TextColor);
            name.Dock = DockStyle.None;
            name.Location = new Point(22, 3);
            name.Height = 18;
            box.Controls.Add(name);
            Label summary = Label(string.IsNullOrEmpty(card.Summary) ? "работает" : card.Summary, smallFont, Muted);
            summary.Dock = DockStyle.None;
            summary.Location = new Point(22, 21);
            summary.Height = 14;
            box.Controls.Add(summary);
            hints.SetToolTip(name, card.Name);
            hints.SetToolTip(summary, card.Summary);

            var actions = new TableLayoutPanel();
            actions.ColumnCount = 3;
            actions.RowCount = 1;
            actions.Margin = Padding.Empty;
            actions.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            for (int column = 0; column < 3; column++)
            {
                actions.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F / 3));
            }
            string id = card.Id;
            string openUrl = card.Open ?? "";
            bool foreign = card.Foreign;
            string projectName = card.Name;
            Button open = Button("project-open-" + id, "Открыть", delegate { RaiseOpen(openUrl); });
            Button again = Button("project-restart-" + id, "Заново", delegate { RaiseCommand(id, projectName, "restart", foreign); });
            Button halt = Button("project-stop-" + id, "Стоп", delegate { RaiseCommand(id, projectName, "stop", foreign); });
            again.Enabled = card.Restart;
            again.Tag = card.Restart;
            hints.SetToolTip(open, string.IsNullOrEmpty(openUrl) ? "Страница проекта" : openUrl);
            hints.SetToolTip(again, "Перезапустить");
            hints.SetToolTip(halt, "Остановить");
            actions.Controls.Add(open, 0, 0);
            actions.Controls.Add(again, 1, 0);
            actions.Controls.Add(halt, 2, 0);
            box.Controls.Add(actions);
            box.Tag = new Control[] { name, summary, actions };
            return box;
        }

        private static Color ToneColor(string tone)
        {
            if (tone == "external") { return Color.FromArgb(96, 165, 250); }
            if (tone == "starting") { return Warning; }
            if (tone == "unhealthy") { return Color.FromArgb(251, 146, 60); }
            return Accent;
        }

        private void EnableProjectButtons(bool pending)
        {
            EnableProjectButtons(projectsHost, pending);
        }

        private static void EnableProjectButtons(Control parent, bool pending)
        {
            foreach (Control child in parent.Controls)
            {
                Button button = child as Button;
                if (button != null && button.Name.StartsWith("project-open-"))
                {
                    button.Enabled = true;
                }
                else if (button != null && button.Name.StartsWith("project-restart-"))
                {
                    button.Enabled = !pending && button.Tag is bool && (bool)button.Tag;
                }
                else if (button != null && button.Name.StartsWith("project-stop-"))
                {
                    button.Enabled = !pending;
                }
                EnableProjectButtons(child, pending);
            }
        }

        private void RaiseOpen(string url)
        {
            Action<string> action = ProjectOpenRequested;
            if (action != null && url.Length > 0)
            {
                action(url);
            }
        }

        private void RaiseCommand(string id, string name, string action, bool foreign)
        {
            if (foreign && (ProjectConfirmation == null || !ProjectConfirmation(name, action)))
            {
                return;
            }
            Action<string, string, bool> command = ProjectCommandRequested;
            if (command != null)
            {
                command(id, action, foreign);
            }
        }

        public void Open()
        {
            if (IsDisposed) { return; }
            if (!Visible) { Show(); }
            if (WindowState == FormWindowState.Minimized) { WindowState = FormWindowState.Normal; }
            BringToFront();
            Activate();
        }

        protected override void OnHandleCreated(EventArgs args)
        {
            base.OnHandleCreated(args);
            try
            {
                int dark = 1;
                DwmSetWindowAttribute(Handle, 20, ref dark, sizeof(int));
            }
            catch (DllNotFoundException) { }
            catch (EntryPointNotFoundException) { }
        }

        protected override void OnFormClosing(FormClosingEventArgs args)
        {
            if (!disposing && args.CloseReason == CloseReason.UserClosing)
            {
                args.Cancel = true;
                Hide();
            }
            base.OnFormClosing(args);
        }

        protected override void Dispose(bool release)
        {
            disposing = true;
            base.Dispose(release);
            if (release)
            {
                hints.Dispose();
                titleFont.Dispose();
                smallFont.Dispose();
            }
        }
    }
}
