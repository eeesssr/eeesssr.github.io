// DeepSeek API配置
const DEEPSEEK_API_KEY = 'sk-de1b0fbea3704574b62cf9b131a15bb1';
const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';

// 添加故事集合
const stories = {
    story1: {
        title: "房间里的死者",
        surface: "一个人在房间里死了。",
        truth: "这个人在玩VR游戏时，因为太过投入，不小心撞到了墙，导致头部受伤死亡。",
        hints: [
            "房间里只有一个人",
            "死者头部有伤",
            "房间里有VR设备",
        ]
    },
    story2: {
        title: "找到你了",
        surface: `哒..哒...哒....
                咚咚咚
                哒....哒...哒..
                哗啦哗啦
                哒..哒…哒….."我找到你了哦"`,
        truth: "主人公目睹杀人案后被杀手追赶，躲进卫生间。杀手的脚步声逐渐远去，但主人公不小心碰到冲水装置，水声引来杀手从门缝发现了他。",
        hints: [
            "哒声代表脚步声，点越多声音越大",
            "咚咚咚是敲门声",
            "哗啦哗啦是冲水声",
            "主人公躲在卫生间里"
        ]
    },
    story3: {
        title: "外婆的苹果",
        surface: "6岁时外婆告诉我不要吃黄苹果。13岁时，外婆告诉我不要吃青苹果。18岁时外婆告诉我不要吃红苹果。20岁时外婆去世了，我向外婆祈愿：以后所有的苹果都可以吃了。",
        truth: `从小家境贫困，全靠外婆种苹果维生。外婆为保护孙女，种下有毒苹果：
               - 6岁时种黄苹果毒死虐待孙女的家人
               - 13岁时种青苹果毒死欺负孙女的同学
               - 18岁时种红苹果毒哑说闲话的村民
               黄青红代表受害人数从少到多。`,
        hints: [
            "外婆种的苹果都有毒",
            "不同颜色的苹果代表不同时期",
            "苹果颜色与受害人数有关",
            "外婆是为了保护孙女",
            "黄苹果针对家人，青苹果针对同学，红苹果针对村民"
        ]
    },
    story4: {
        title: "人鱼公主",
        surface: "美人鱼与人类王子相爱并一起来到了王子的国家，可不久后却传来了王子的死讯。",
        truth: `人鱼公主嫁给善良的王子来到陆地。这个国家由于王后辛德瑞拉的报复，大多数人都没有双腿。
               人们听说吃了人鱼肉就能在海里生活，想要吃掉人鱼公主。
               王子为保护心爱的人鱼公主，选择自杀并留下"人鱼不能吃，有毒!"的遗言，
               用自己的生命让大家相信人鱼肉有毒，从而保护了人鱼公主。`,
        hints: [
            "这个国家很多人都没有双腿",
            "人们相信吃了人鱼肉可以在海里生活",
            "王子的死是自愿的",
            "人鱼肉实际上并没有毒",
            "王后辛德瑞拉与这个故事有关",
            "王子是为了保护人鱼公主而死"
        ]
    },
    story5: {
        title: "灰姑娘的真相",
        surface: "灰姑娘最终嫁给了王子，成为了王后辛德瑞拉。",
        truth: `这个版本的灰姑娘故事有着黑暗的结局。
               灰姑娘嫁给王子后，王子因为某种原因砍断了她的双腿。
               充满怨恨的辛德瑞拉后来成为王后，为了报复，
               她下令砍断了这个国家许多人的双腿。
               这就是为什么在人鱼公主的故事中，这个国家会有那么多没有双腿的人。`,
        hints: [
            "辛德瑞拉失去了双腿",
            "这是王子对她做的",
            "她后来报复了整个国家",
            "她让很多人都失去了双腿",
            "这个故事与人鱼公主的故事相关联"
        ]
    }
};

let currentStory = stories.story1; // 默认显示第一个故事

// 添加问答记录数组
let questionHistory = [];

// 添加故事选择功能
function createStorySelector() {
    const selector = document.createElement('select');
    selector.id = 'story-selector';
    
    Object.keys(stories).forEach(key => {
        const option = document.createElement('option');
        option.value = key;
        option.textContent = stories[key].title;
        selector.appendChild(option);
    });

    selector.addEventListener('change', (e) => {
        currentStory = stories[e.target.value];
        document.getElementById('story').textContent = currentStory.surface;
        document.getElementById('answer').textContent = '';
        document.getElementById('hint').style.display = 'none';
        document.getElementById('show-hint').textContent = '显示提示';
        currentHintIndex = 0;
        
        // 清空历史记录
        questionHistory = [];
        updateHistoryDisplay();
    });

    return selector;
}

// 在页面加载时初始化故事选择器
document.addEventListener('DOMContentLoaded', () => {
    const container = document.querySelector('.container');
    const storySelector = createStorySelector();
    container.insertBefore(storySelector, container.firstChild);
    
    // 显示初始故事
    document.getElementById('story').textContent = currentStory.surface;
    
    // 添加提示按钮功能
    const showHintButton = document.getElementById('show-hint');
    const hintElement = document.getElementById('hint');
    let currentHintIndex = 0;
    
    showHintButton.addEventListener('click', () => {
        if (hintElement.style.display === 'none' || !hintElement.style.display) {
            hintElement.style.display = 'block';
            if (currentHintIndex < currentStory.hints.length) {
                hintElement.textContent = currentStory.hints[currentHintIndex];
                currentHintIndex++;
                if (currentHintIndex >= currentStory.hints.length) {
                    showHintButton.textContent = '重置提示';
                }
            } else {
                currentHintIndex = 0;
                hintElement.style.display = 'none';
                showHintButton.textContent = '显示提示';
            }
        }
    });
});

// 添加猜测真相的功能
function checkGuessAccuracy(question) {
    const truthKeywords = currentStory.truth.toLowerCase().split(/[,.\s]+/);
    const questionKeywords = question.toLowerCase().split(/[,.\s]+/);
    
    // 计算关键词匹配度
    let matchCount = 0;
    let totalKeywords = new Set(truthKeywords).size;
    
    questionKeywords.forEach(word => {
        if (truthKeywords.includes(word) && word.length > 1) {
            matchCount++;
        }
    });
    
    // 计算匹配率
    const matchRate = matchCount / totalKeywords;
    return matchRate > 0.6; // 如果匹配率超过60%，认为玩家已经猜到真相
}

// 添加历史问答分析功能
function analyzeHistoryForTruth() {
    // 获取所有关键信息点
    const keyPoints = getStoryKeyPoints(currentStory.truth);
    let discoveredPoints = new Set();
    
    // 分析历史记录中的每个问答
    questionHistory.forEach(({question, answer}) => {
        if (answer === '是') {
            // 分析问题中包含的关键信息
            keyPoints.forEach(point => {
                if (question.toLowerCase().includes(point.toLowerCase())) {
                    discoveredPoints.add(point);
                }
            });
        }
    });
    
    // 计算已发现的关键信息比例
    const discoveryRate = discoveredPoints.size / keyPoints.length;
    return discoveryRate > 0.7; // 如果发现了70%以上的关键信息，认为可以揭示真相
}

// 提取故事关键信息点
function getStoryKeyPoints(truth) {
    // 根据不同故事提取不同的关键信息点
    const storyKeyPoints = {
        story1: ["VR游戏", "头部受伤", "撞到墙"],
        story2: ["杀手追赶", "躲进卫生间", "水声引来杀手"],
        story3: ["外婆种苹果", "毒苹果", "保护孙女"],
        story4: ["人鱼公主", "没有双腿", "王子自杀", "保护人鱼"],
        story5: ["辛德瑞拉", "砍断双腿", "报复"]
    };
    
    // 获取当前故事的ID
    const storyId = Object.keys(stories).find(key => stories[key].truth === truth);
    return storyKeyPoints[storyId] || [];
}

// 修改analyzeQuestion函数
async function analyzeQuestion(question) {
    // 检查是否包含"真相"、"答案"等关键词
    const guessPattern = /[真相|答案|汤底|结局|原因]/;
    const isGuessing = guessPattern.test(question);
    
    // 如果玩家在尝试猜测真相
    if (isGuessing) {
        // 检查是否通过关键词匹配或历史分析可以揭示真相
        if (checkGuessAccuracy(question) || analyzeHistoryForTruth()) {
            return `恭喜你猜到了真相！\n\n这个故事的真相是：\n${currentStory.truth}`;
        } else {
            return "看起来你还没有发现足够的线索，继续探索吧！";
        }
    }
    
    const prompt = `
    基于以下故事背景，请只回答"是"、"否"、"是或否"、"无关"其中之一：
    
    表面故事：${currentStory.surface}
    真相：${currentStory.truth}
    当前问题历史：${JSON.stringify(questionHistory)}
    
    问题：${question}
    `;

    try {
        const response = await fetch(DEEPSEEK_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
            },
            body: JSON.stringify({
                model: "deepseek-chat",
                messages: [{
                    role: "user",
                    content: prompt
                }]
            })
        });

        const data = await response.json();
        return data.choices[0].message.content;
    } catch (error) {
        console.error('API Error:', error);
        return '系统错误';
    }
}

// 修改displayAnswer函数来支持多行显示
function displayAnswer(answer, question) {
    const answerContainer = document.getElementById('answer');
    answerContainer.innerHTML = answer.replace(/\n/g, '<br>');
    
    // 添加到历史记录
    questionHistory.push({ question, answer });
    updateHistoryDisplay();
}

// 修改历史记录显示函数来支持多行显示
function updateHistoryDisplay() {
    const historyContainer = document.getElementById('history-container');
    historyContainer.innerHTML = '';
    
    questionHistory.forEach((item, index) => {
        const questionDiv = document.createElement('div');
        questionDiv.className = 'history-item';
        
        // 如果答案包含真相，使用特殊样式
        const isRevealedTruth = item.answer.includes('恭喜你猜到了真相');
        const answerClass = isRevealedTruth ? 'history-answer truth-revealed' : 'history-answer';
        
        questionDiv.innerHTML = `
            <span class="history-number">${index + 1}</span>
            <span class="history-question">${item.question}</span>
            <span class="${answerClass}">${item.answer.replace(/\n/g, '<br>')}</span>
        `;
        historyContainer.appendChild(questionDiv);
    });
}

// 更新提交问题的事件处理
document.getElementById('submit-question').addEventListener('click', async () => {
    const questionInput = document.getElementById('question-input');
    const question = questionInput.value;
    if (!question) return;

    const loadingElement = document.getElementById('loading');
    const answerElement = document.getElementById('answer');
    
    try {
        loadingElement.style.display = 'block';
        answerElement.style.opacity = '0.5';
        
        const answer = await analyzeQuestion(question);
        displayAnswer(answer, question);
        questionInput.value = ''; // 清空输入框
    } catch (error) {
        console.error('Error:', error);
        displayAnswer('抱歉，系统出现错误，请稍后再试。', question);
    } finally {
        loadingElement.style.display = 'none';
        answerElement.style.opacity = '1';
    }
}); 