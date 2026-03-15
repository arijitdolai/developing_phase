const puppeteer = require('puppeteer');

class BotSimulator {
    constructor() {
        this.browser = null;
        this.page = null;
    }

    async init(url) {
        // Launching with 'headless: false' lets you see the bot in action
        this.browser = await puppeteer.launch({ headless: false });
        this.page = await this.browser.newPage();
        await this.page.goto(url);
    }

    // PROFILE 1: The "Instant" Bot (Teleportation)
    // Most basic bot: no intermediate coordinates recorded
    async teleportMove(x, y) {
        console.log(`Teleporting to ${x}, ${y}`);
        await this.page.mouse.move(x, y); 
        await this.page.mouse.click(x, y);
    }

    // PROFILE 2: The "Linear" Bot (Mathematical perfection)
    // Moves in a perfectly straight line with 0 variance
    async linearMove(targetX, targetY, steps = 10) {
        console.log("Executing Linear Movement...");
        const start = await this.page.evaluate(() => ({ x: window.scrollX, y: window.scrollY })); 
        // Note: simplified start point; usually tracked from last known pos
        
        for (let i = 0; i <= steps; i++) {
            const x = i * (targetX / steps);
            const y = i * (targetY / steps);
            await this.page.mouse.move(x, y);
            // No jitter or delay variation here
            await new Promise(r => setTimeout(r, 20)); 
        }
    }

    // PROFILE 3: The "Jitter" Bot (Attempting to bypass simple checks)
    // Adds random noise, but often lacks human acceleration curves
    async jitterMove(targetX, targetY) {
        console.log("Executing Jitter Movement...");
        for (let i = 0; i < 20; i++) {
            const x = (i * (targetX / 20)) + (Math.random() * 5);
            const y = (i * (targetY / 20)) + (Math.random() * 5);
            await this.page.mouse.move(x, y);
            await new Promise(r => setTimeout(r, Math.random() * 50));
        }
    }

    async close() {
        await this.browser.close();
    }
}

// EXECUTION SCRIPT
(async () => {
    const tester = new BotSimulator();
    await tester.init('http://localhost:3000'); 

    console.log("--- STARTING PERPETUAL BOT ATTACK ---");

    // This loop keeps the bot active so your threshold can be reached
    for (let i = 0; i < 50; i++) { 
        console.log(`Attack Wave #${i}`);
        
        // Simulate a bot-like linear move
        await tester.linearMove(Math.random() * 1000, Math.random() * 800, 100);
        
        // Wait a bit to simulate "thinking" (even bots do this)
        await new Promise(r => setTimeout(r, 500));
    }

    console.log("Testing complete. If not detected, your threshold may be too high!");
})();